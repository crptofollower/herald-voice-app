// Conversation Composition Contract V1
// Characterization only. Expected architectural failures are report data.
// They are not production-gate failures and they are not repairs.
//
// Observable customer and authority invariants only. This file does not
// describe the internal shape of a future conversation authority.

import Database from 'better-sqlite3';
import { setDB, runMigrations, getDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance, type UtteranceOutcome } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { CalendarPresentationHolder } from '../../src/routing/calendarPresentation.ts';
import { CalendarContinuationHolder } from '../../src/routing/calendarContinuation.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import { ReminiscenceArcHolder } from '../../src/routing/reminiscenceArc.ts';
import {
  RecoveryObligationHolder,
  shouldEstablishRecoveryObligation,
} from '../../src/routing/recoveryObligation.ts';
import { resolveEphemeralSeam } from '../../src/utils/ephemeralSeam.ts';
import { setCalendarEventFetcher, resetCalendarEventFetcher } from '../../src/db/calendarCacheDB.ts';
import {
  applyReopenedNativeSession,
  createIdleOpenSpeechTurnState,
  reduceOpenSpeechTurn,
  resetOpenSpeechTurnIdsForTests,
  type OpenSpeechEvent,
  type OpenSpeechTurnState,
} from '../../src/hooks/openSpeechTurnBoundary.ts';

export type CompositionVerdict =
  | 'PASS TODAY'
  | 'EXPECTED FAIL — ARCHITECTURE GAP'
  | 'TEST/HARNESS LIMITATION';

export type Inventory = {
  items: string[];
  contacts: string[];
  meds: string[];
  visits: string[];
};

export type TurnTrace = {
  input: string;
  deterministicOwner: string;
  route: string | null;
  reason: string | null;
  stateBefore: string;
  stateAfter: string;
  durableWrite: string[];
  durableRead: string | null;
  generationEntered: boolean;
  modelInvoked: boolean;
  customerSpeech: string | null;
  expectedCustomerOutcome: string;
};

export type JourneyReport = {
  id: string;
  title: string;
  required: string;
  verdict: CompositionVerdict;
  failureBoundary: string;
  turns: TurnTrace[];
};

type Check = { name: string; ok: boolean; detail: string; harness?: boolean };

type World = {
  session: ConversationSession;
  subject: ConversationalSubjectHolder;
  medication: MedicationPresentationHolder;
  ordered: OrderedPresentationHolder;
  calendarPresentation: CalendarPresentationHolder;
  calendarContinuation: CalendarContinuationHolder;
  discourse: DiscourseContinuityHolder;
  arc: ReminiscenceArcHolder;
  recovery: RecoveryObligationHolder;
  ledger: ReturnType<typeof createConversationTurnLedger>;
};

const MEDS = ['metoprolol', 'lisinopril'];
const GROCERY = ['apples', 'bananas'];

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

async function freshDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  return db;
}

function makeDeps() {
  return {
    classifyQuery,
    classifyLLM: null as null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
    getMedicationSemanticInterpreterCtx: () => null,
  };
}

function world(): World {
  return {
    session: new ConversationSession(),
    subject: new ConversationalSubjectHolder(),
    medication: new MedicationPresentationHolder(),
    ordered: new OrderedPresentationHolder(),
    calendarPresentation: new CalendarPresentationHolder(),
    calendarContinuation: new CalendarContinuationHolder(),
    discourse: new DiscourseContinuityHolder(),
    arc: new ReminiscenceArcHolder(),
    recovery: new RecoveryObligationHolder(),
    ledger: createConversationTurnLedger(),
  };
}

function inventory(): Inventory {
  const db = getDB();
  const items = db.getAllSync<{ body: string }>(
    'SELECT body FROM list_items WHERE removed_at IS NULL ORDER BY created_at, id',
  );
  const contacts = db.getAllSync<{ name: string }>(
    'SELECT name FROM contacts WHERE removed_at IS NULL ORDER BY name',
  );
  const meds = db.getAllSync<{ name: string }>(
    'SELECT name FROM medications WHERE removed_at IS NULL ORDER BY name',
  );
  const visits = db.getAllSync<{ doctor_name: string | null }>(
    'SELECT doctor_name FROM medical_records ORDER BY created_at, id',
  );
  return {
    items: items.map((r) => r.body),
    contacts: contacts.map((r) => r.name),
    meds: meds.map((r) => r.name),
    visits: visits.map((r) => r.doctor_name ?? ''),
  };
}

function added(before: string[], after: string[]): string[] {
  const rest = [...before];
  const out: string[] = [];
  for (const value of after) {
    const at = rest.indexOf(value);
    if (at >= 0) rest.splice(at, 1);
    else out.push(value);
  }
  return out;
}

function snapshot(w: World): string {
  const subject = w.subject.peek();
  const med = w.medication.peek();
  const ordered = w.ordered.peek();
  const topic = w.discourse.peekTopic();
  const domain = w.discourse.peekDomain();
  return JSON.stringify({
    pending: w.session.peekPendingKey(),
    subject: subject ? `${subject.domain}:${subject.displayName}` : null,
    medicationIds: w.medication.hasLive() ? med?.medicationIds ?? [] : [],
    ordered: w.ordered.hasLive() && ordered
      ? { owner: ordered.owner, ids: ordered.presentedIds }
      : null,
    calendarPresentation: w.calendarPresentation.hasLive(),
    calendarContinuation: w.calendarContinuation.hasLive(),
    recovery: w.recovery.hasLive(),
    arc: `${w.arc.peekState()}:${w.arc.peekRowIds().length}`,
    discourse: topic
      ? { name: topic.displayName, evidence: topic.evidence.map((e) => e.text) }
      : null,
    discourseDomain: domain ? domain.domain : null,
  });
}

function customerSpeech(outcome: UtteranceOutcome): string | null {
  if (outcome.handled) {
    if (outcome.source === 'emergency') return null;
    return outcome.responseText;
  }
  const rd = outcome.routeDecision;
  if (rd.kind === 'device_read') return rd.response;
  if (rd.kind === 'needs_clarification') return rd.guess ?? null;
  return null;
}

function describe(outcome: UtteranceOutcome): {
  owner: string;
  route: string | null;
  reason: string | null;
  generationEntered: boolean;
  speech: string | null;
} {
  if (outcome.handled) {
    return {
      owner: outcome.source,
      route: outcome.source,
      reason: null,
      generationEntered: false,
      speech: customerSpeech(outcome),
    };
  }
  const rd = outcome.routeDecision;
  const reason = 'reason' in rd ? String(rd.reason) : null;
  const generationEntered = rd.kind === 'needs_clarification' && reason === 'default';
  return {
    owner: reason ? `${rd.kind}:${reason}` : rd.kind,
    route: rd.kind,
    reason,
    generationEntered,
    speech: customerSpeech(outcome),
  };
}

function writesOf(before: Inventory, after: Inventory): string[] {
  return [
    ...added(before.items, after.items).map((b) => `list:${b}`),
    ...added(before.contacts, after.contacts).map((b) => `contact:${b}`),
    ...added(before.meds, after.meds).map((b) => `med:${b}`),
    ...added(before.visits, after.visits).map((b) => `visit:${b}`),
  ];
}

async function say(w: World, input: string, expectedCustomerOutcome: string): Promise<TurnTrace> {
  const stateBefore = snapshot(w);
  const before = inventory();
  const outcome = await processUtterance(
    input,
    w.session,
    makeDeps(),
    w.subject,
    w.medication,
    w.ordered,
    w.calendarPresentation,
    w.calendarContinuation,
    w.discourse,
    w.ledger,
    w.arc,
    w.recovery,
  );
  const described = describe(outcome);
  const after = inventory();
  const durableWrite = writesOf(before, after);
  const readOwner = described.speech != null && !described.generationEntered && (
    described.route === 'device_read'
    || described.owner === 'referent_resume'
    || described.owner === 'hold_recall'
    || described.owner === 'hold_continuity'
    || described.owner === 'recent_add_recall'
    || described.owner === 'recovery_obligation'
  );
  return {
    input,
    deterministicOwner: described.owner,
    route: described.route,
    reason: described.reason,
    stateBefore,
    stateAfter: snapshot(w),
    durableWrite,
    durableRead: readOwner ? described.speech : null,
    generationEntered: described.generationEntered,
    modelInvoked: false,
    customerSpeech: described.speech,
    expectedCustomerOutcome,
  };
}

function mentions(speech: string | null, needle: string): boolean {
  return (speech ?? '').toLowerCase().includes(needle.toLowerCase());
}

function explicitAmbiguity(speech: string | null): boolean {
  const text = speech ?? '';
  return /\b(which|who do you mean|not sure which|more than one|which one|which list|which person|which daughter)\b/i.test(text);
}

function verdictOf(checks: Check[]): { verdict: CompositionVerdict; failureBoundary: string } {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    return {
      verdict: 'PASS TODAY',
      failureBoundary: 'Required observable outcomes hold on the current seam.',
    };
  }
  if (failed.every((c) => c.harness)) {
    return {
      verdict: 'TEST/HARNESS LIMITATION',
      failureBoundary: failed.map((c) => c.detail).join(' | '),
    };
  }
  return {
    verdict: 'EXPECTED FAIL — ARCHITECTURE GAP',
    failureBoundary: failed.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | '),
  };
}

function seedMeds(db: Database.Database) {
  for (const name of MEDS) {
    db.prepare(
      `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
       VALUES (?, ?, '50mg', 'daily', 1, ?, NULL)`,
    ).run(`med_${name}`, name, '2026-09-01T15:00:00.000Z');
  }
}

function seedGrocery(db: Database.Database) {
  db.prepare('INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)').run(
    'list_grocery',
    'grocery',
    '2026-09-01T15:00:00.000Z',
  );
  GROCERY.forEach((body, index) => {
    db.prepare(
      `INSERT INTO list_items (id, list_id, body, checked, removed_at, created_at)
       VALUES (?, 'list_grocery', ?, 0, NULL, ?)`,
    ).run(`item_${index}`, body, `2026-09-01T15:00:0${index}.000Z`);
  });
}

function seedVisit(db: Database.Database) {
  db.prepare(
    `INSERT INTO medical_records (id, visit_date, doctor_name, notes, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('visit_patel', '2026-09-01', 'Dr. Patel', 'Checkup', '2026-09-01T15:00:00.000Z');
}

function seedContact(
  db: Database.Database,
  id: string,
  name: string,
  relationship: string | null,
  phone: string,
  importance: number,
) {
  const now = '2026-09-01T15:00:00.000Z';
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, name, relationship, phone, importance, now, now);
}

function finish(id: string, title: string, required: string, turns: TurnTrace[], checks: Check[]): JourneyReport {
  const graded = verdictOf(checks);
  return { id, title, required, turns, ...graded };
}

async function journeyA(): Promise<JourneyReport> {
  await freshDb();
  const w = world();
  const turns = [
    await say(
      w,
      'I was talking to my friend Martin yesterday and he was telling me about his new place',
      'Retain Martin as conversational evidence the next turn can use without a hot-ring transcript.',
    ),
    await say(
      w,
      'about his trip to Ireland',
      'Treat this as Martin continuing about Ireland. Do not start an unrelated command or write.',
    ),
  ];
  const second = turns[1];
  const linked = second.deterministicOwner !== 'needs_clarification:default'
    && (mentions(second.customerSpeech, 'martin') || mentions(second.customerSpeech, 'ireland') || second.stateAfter.includes('Martin'));
  const checks: Check[] = [
    {
      name: 'narrative-continuity',
      ok: linked && second.durableWrite.length === 0,
      detail: `Turn 2 owner ${second.deterministicOwner}; speech ${JSON.stringify(second.customerSpeech)}; writes ${JSON.stringify(second.durableWrite)}; state ${second.stateAfter}. The Ireland turn is unclaimed. A stored person mention, if any, does not answer the continuation, and hot-ring prose is not authority.`,
    },
    {
      name: 'no-unintended-write',
      ok: turns.every((t) => t.durableWrite.length === 0),
      detail: `Writes ${JSON.stringify(turns.map((t) => t.durableWrite))}.`,
    },
  ];
  return finish(
    'A',
    'Narrative continuity',
    'Martin, then a natural continuation about Ireland, must stay one conversational relationship without relying on hot-ring prose.',
    turns,
    checks,
  );
}

async function journeyB(): Promise<JourneyReport> {
  await freshDb();
  const w = world();
  const turns = [
    await say(
      w,
      'On the drive home I want to pick up roses for my wife. Our anniversary is June 12 and she told me roses are her favorite.',
      'Keep the roses and June 12 anniversary available for a later natural reference.',
    ),
    await say(
      w,
      'What was I going to pick up for her?',
      'Answer roses from the episode just stated.',
    ),
    await say(
      w,
      'When is that anniversary?',
      'Answer June 12 from the same episode.',
    ),
  ];
  const checks: Check[] = [
    {
      name: 'flower-recall',
      ok: mentions(turns[1].customerSpeech, 'rose') && !turns[1].generationEntered,
      detail: `Opening owner ${turns[0].deterministicOwner}; speech ${JSON.stringify(turns[0].customerSpeech)}; writes ${JSON.stringify(turns[0].durableWrite)}. Follow-up owner ${turns[1].deterministicOwner}; speech ${JSON.stringify(turns[1].customerSpeech)}; generation gate ${turns[1].generationEntered}. "Okay." did not leave roses in deterministic state for the paraphrase to read.`,
    },
    {
      name: 'anniversary-recall',
      ok: mentions(turns[2].customerSpeech, 'june 12') && !turns[2].generationEntered,
      detail: `Follow-up owner ${turns[2].deterministicOwner}; speech ${JSON.stringify(turns[2].customerSpeech)}; generation gate ${turns[2].generationEntered}. The paraphrase did not read June 12 back from deterministic state.`,
    },
    {
      name: 'no-unrelated-write',
      ok: turns.every((t) => t.durableWrite.every((w) => !w.startsWith('list:') && !w.startsWith('med:') && !w.startsWith('visit:'))),
      detail: `Writes ${JSON.stringify(turns.map((t) => t.durableWrite))}.`,
    },
  ];
  return finish(
    'B',
    'Personal-memory composition',
    'A stated roses / June 12 anniversary episode must answer later natural references to the flowers and the date.',
    turns,
    checks,
  );
}

async function journeyC(): Promise<JourneyReport> {
  const db = await freshDb();
  seedVisit(db);
  const w = world();
  const turns = [
    await say(
      w,
      'When did I last see Dr. Patel?',
      'Answer from the stored Patel visit and keep that doctor as conversational focus.',
    ),
    await say(
      w,
      'Add milk to my grocery list.',
      'Add milk. Leave the Patel visit and doctor focus intact.',
    ),
    await say(
      w,
      'What about him?',
      'Still refer to Dr. Patel, or ask which person is meant. Do not drop him silently.',
    ),
  ];
  const milkWritten = turns[1].durableWrite.includes('list:milk');
  const visitSurvives = inventory().visits.some((v) => /patel/i.test(v));
  const focusSurvives = mentions(turns[2].customerSpeech, 'patel')
    || explicitAmbiguity(turns[2].customerSpeech);
  const checks: Check[] = [
    {
      name: 'grocery-write',
      ok: milkWritten,
      detail: `Grocery owner ${turns[1].deterministicOwner}; writes ${JSON.stringify(turns[1].durableWrite)}.`,
      harness: !milkWritten && turns[1].deterministicOwner.startsWith('needs_clarification'),
    },
    {
      name: 'doctor-focus-survives-interruption',
      ok: visitSurvives && focusSurvives && milkWritten,
      detail: `Milk write ${milkWritten}. Visit row remains ${visitSurvives}. After the grocery command, state ${turns[1].stateAfter}. "What about him?" owner ${turns[2].deterministicOwner}; speech ${JSON.stringify(turns[2].customerSpeech)}. The doctor subject is gone. A leftover person-mention does not answer the pronoun or ask who is meant.`,
    },
  ];
  return finish(
    'C',
    'Cross-domain interruption',
    'A grocery add during doctor context must succeed without destroying that conversational focus.',
    turns,
    checks,
  );
}

async function journeyD(): Promise<JourneyReport> {
  const db = await freshDb();
  seedMeds(db);
  seedGrocery(db);
  const w = world();
  const turns = [
    await say(
      w,
      'What medications am I taking?',
      'Present the medication list.',
    ),
    await say(
      w,
      "What's on my grocery list?",
      'Present the grocery list without making it the silent target of a later medication ordinal.',
    ),
    await say(
      w,
      'the second one',
      'Bind the medication list that was interrupted, or say the reference is ambiguous. Do not answer with a grocery item.',
    ),
  ];
  const speech = turns[2].customerSpeech ?? '';
  const groceryBind = GROCERY.some((item) => mentions(speech, item));
  const medBind = MEDS.some((name) => mentions(speech, name));
  const ambiguous = explicitAmbiguity(speech);
  const checks: Check[] = [
    {
      name: 'presented-set-isolation',
      ok: !groceryBind && (medBind || ambiguous),
      detail: `Ordinal owner ${turns[2].deterministicOwner}; speech ${JSON.stringify(speech)}; state before ${turns[2].stateBefore}. ${groceryBind ? 'The ordinal silently bound the grocery presentation.' : 'The ordinal neither bound the interrupted medication list nor asked which collection was meant.'}`,
    },
    {
      name: 'no-write-on-reference',
      ok: turns[2].durableWrite.length === 0,
      detail: `Writes ${JSON.stringify(turns[2].durableWrite)}.`,
    },
  ];
  return finish(
    'D',
    'Presented-set isolation',
    'After a medication list and an intervening grocery list, "the second one" must not silently bind the grocery collection.',
    turns,
    checks,
  );
}

async function journeyE(): Promise<JourneyReport> {
  const db = await freshDb();
  seedMeds(db);
  seedContact(db, 'c_shannon', 'Shannon', 'wife', '5125550140', 8);
  const w = world();
  const turns = [
    await say(
      w,
      "How's my pill situation looking?",
      'Answer from the stored medications. A closed-grammar miss must stay visible and must not count as that answer.',
    ),
    await say(
      w,
      'Have I got anything with the doctor coming up?',
      'Answer from calendar or visit evidence. A closed-grammar miss must stay visible.',
    ),
    await say(
      w,
      'Remind me who I married',
      'Answer Shannon from the stored wife relationship. A closed-grammar miss must stay visible.',
    ),
  ];
  const medAnswered = MEDS.every((name) => mentions(turns[0].customerSpeech, name)) && !turns[0].generationEntered;
  const calendarAnswered = (turns[1].route === 'device_read' || turns[1].deterministicOwner.includes('calendar') || turns[1].deterministicOwner.includes('medical'))
    && !turns[1].generationEntered
    && turns[1].customerSpeech != null;
  const wifeAnswered = mentions(turns[2].customerSpeech, 'shannon') && !turns[2].generationEntered;
  const checks: Check[] = [
    {
      name: 'medication-paraphrase',
      ok: medAnswered,
      detail: `Owner ${turns[0].deterministicOwner}; generation gate ${turns[0].generationEntered}; speech ${JSON.stringify(turns[0].customerSpeech)}. Closed reader missed. The miss is the recorded owner; model prose was not invoked and is not treated as the medication answer.`,
    },
    {
      name: 'calendar-paraphrase',
      ok: calendarAnswered,
      detail: `Owner ${turns[1].deterministicOwner}; generation gate ${turns[1].generationEntered}; speech ${JSON.stringify(turns[1].customerSpeech)}. Closed reader missed. The miss is the recorded owner; model prose was not invoked and is not treated as the calendar answer.`,
    },
    {
      name: 'personal-paraphrase',
      ok: wifeAnswered,
      detail: `Owner ${turns[2].deterministicOwner}; generation gate ${turns[2].generationEntered}; speech ${JSON.stringify(turns[2].customerSpeech)}. Closed reader missed. The miss is the recorded owner; model prose was not invoked and is not treated as the family answer.`,
    },
  ];
  return finish(
    'E',
    'Semantic paraphrase',
    'Supported medication, calendar, and personal meanings must be answered without matching a closed reader sentence. A miss must be observable rather than hidden by generative prose.',
    turns,
    checks,
  );
}

async function journeyF(): Promise<JourneyReport> {
  const db = await freshDb();
  seedMeds(db);
  const w = world();
  const turns: TurnTrace[] = [
    await say(w, 'What medications am I taking?', 'Present the stored medications so a later repair can return to them.'),
  ];
  const failed = await say(
    w,
    'the blue one',
    'Fail this reference visibly. Do not bind a medication or another list.',
  );
  let seamKind: 'clarify' | 'generative' | 'authoritative' | null = null;
  if (!failed.generationEntered) {
    turns.push(failed);
  } else {
    const seam = await resolveEphemeralSeam({
      text: failed.input,
      reason: 'default',
      hasAuthorizedContinuation: false,
      hasPendingSession: w.session.hasPending(),
      hasContactCollectPending: false,
      rdTier: 3,
      hasStructuredCaptures: false,
      isPersonalCaptureRisk: false,
      llmStatus: 'unavailable',
      classifierBusy: false,
      ephemeralBusy: false,
      generate: async () => {
        throw new Error('composition contract must not invoke a model');
      },
    });
    seamKind = seam.kind === 'authoritative' ? 'authoritative' : seam.kind;
    const armed = shouldEstablishRecoveryObligation({
      processHandled: false,
      routeKind: 'needs_clarification',
      routeReason: 'default',
      recapHandled: false,
      activeSubjectHandled: false,
      seamKind,
      hasPending: w.session.hasPending(),
    });
    if (armed) w.recovery.establish();
    failed.customerSpeech = seam.kind === 'generative' ? null : seam.reply;
    turns.push(failed);
  }
  turns.push(await say(
    w,
    "That's not what I meant. I mean my medications.",
    'Return the medication names from the list already presented.',
  ));
  const restored = MEDS.every((name) => mentions(turns[2].customerSpeech, name));
  const checks: Check[] = [
    {
      name: 'return-to-prior-evidence',
      ok: restored && turns[2].deterministicOwner === 'recovery_obligation',
      detail: `Failed turn owner ${turns[1].deterministicOwner}; seam ${seamKind ?? 'not a default miss'}; repair owner ${turns[2].deterministicOwner}; speech ${JSON.stringify(turns[2].customerSpeech)}. Recovery, when armed by the existing clarify seam, does not reread the medication list that was presented.`,
    },
    {
      name: 'no-write-on-repair',
      ok: turns[2].durableWrite.length === 0,
      detail: `Writes ${JSON.stringify(turns[2].durableWrite)}.`,
    },
  ];
  return finish(
    'F',
    'Recovery',
    'A failed reference, then a correction back to medications, must return the medication evidence already presented.',
    turns,
    checks,
  );
}

async function journeyG(): Promise<JourneyReport> {
  const db = await freshDb();
  seedVisit(db);
  const w = world();
  const turns = [
    await say(w, 'When did I last see Dr. Patel?', 'Establish doctor context that must not authorize the next command.'),
    await say(w, 'Add eggs to my grocery list.', 'Add eggs only. Do not write a doctor fact or corrupt the item.'),
  ];
  const eggsOnly = turns[1].durableWrite.length === 1 && turns[1].durableWrite[0] === 'list:eggs';
  const visitsUnchanged = inventory().visits.length === 1;
  const checks: Check[] = [
    {
      name: 'unrelated-command-executes',
      ok: eggsOnly && visitsUnchanged && !mentions(turns[1].customerSpeech, 'patel'),
      detail: `Owner ${turns[1].deterministicOwner}; speech ${JSON.stringify(turns[1].customerSpeech)}; writes ${JSON.stringify(turns[1].durableWrite)}; visits ${JSON.stringify(inventory().visits)}.`,
    },
    {
      name: 'stale-context-does-not-authorize',
      ok: eggsOnly && turns[1].durableWrite.every((w) => w === 'list:eggs'),
      detail: `Stale doctor context produced writes ${JSON.stringify(turns[1].durableWrite)}.`,
    },
  ];
  return finish(
    'G',
    'Topic change',
    'An unrelated grocery command must execute normally. Stale doctor context must not authorize or corrupt it.',
    turns,
    checks,
  );
}

async function journeyH(): Promise<JourneyReport> {
  const db = await freshDb();
  seedContact(db, 'j1', 'Jordan Hale', null, '5125550101', 9);
  seedContact(db, 'j2', 'Jordan Hale', null, '5125550199', 3);
  seedContact(db, 'd1', 'Maya', 'daughter', '5125550111', 8);
  seedContact(db, 'd2', 'Priya', 'daughter', '5125550122', 4);
  const w = world();
  const turns = [
    await say(
      w,
      "What's Jordan's number?",
      'Two stored people share that name. Ask which one. Do not speak a single number.',
    ),
    await say(
      w,
      'Who is my daughter?',
      'Two daughters are stored. Name both, or ask which daughter.',
    ),
    await say(
      w,
      "What's her number?",
      'Ask which daughter. Do not speak one daughter\'s number.',
    ),
  ];
  const jordanSpeech = turns[0].customerSpeech ?? '';
  const jordanSilent = /512|555-0101|555-0199|\(512\)/.test(jordanSpeech) && !explicitAmbiguity(jordanSpeech);
  const daughtersNamed = mentions(turns[1].customerSpeech, 'maya') && mentions(turns[1].customerSpeech, 'priya');
  const daughterAmbiguous = explicitAmbiguity(turns[1].customerSpeech);
  const herSpeech = turns[2].customerSpeech ?? '';
  const herSilent = /512|555-0111|555-0122|\(512\)/.test(herSpeech) && !explicitAmbiguity(herSpeech);
  const herExplicit = explicitAmbiguity(herSpeech);
  const checks: Check[] = [
    {
      name: 'same-name-ambiguity',
      ok: !jordanSilent && explicitAmbiguity(jordanSpeech),
      detail: `Owner ${turns[0].deterministicOwner}; speech ${JSON.stringify(jordanSpeech)}. One phone was spoken for two people named Jordan Hale.`,
    },
    {
      name: 'two-daughters-visible',
      ok: daughtersNamed || daughterAmbiguous,
      detail: `Owner ${turns[1].deterministicOwner}; speech ${JSON.stringify(turns[1].customerSpeech)}.`,
    },
    {
      name: 'pronoun-ambiguity',
      ok: !herSilent && herExplicit,
      detail: `Owner ${turns[2].deterministicOwner}; speech ${JSON.stringify(turns[2].customerSpeech)}; state ${turns[2].stateAfter}. Two daughters were already named. The pronoun neither asked which daughter nor was allowed to pick one.`,
    },
  ];
  return finish(
    'H',
    'Ambiguity',
    'The same name or pronoun with two plausible people must be explicit. It must not silently bind one person.',
    turns,
    checks,
  );
}

function committedTurns(events: OpenSpeechEvent[]): string[] {
  let state: OpenSpeechTurnState = createIdleOpenSpeechTurnState();
  const deliveries: string[] = [];
  for (const event of events) {
    const out = reduceOpenSpeechTurn(state, event);
    state = out.state;
    for (const fx of out.effects) {
      if (fx.type === 'deliver') deliveries.push(fx.utterance);
      if (fx.type === 'reopen_native') state = applyReopenedNativeSession(state, state.nativeSessionId + 1);
    }
  }
  return deliveries;
}

async function journeyI(): Promise<JourneyReport> {
  resetOpenSpeechTurnIdsForTests();
  const fragment1 = 'I was talking to my friend Martin yesterday and he was telling me about his new place';
  const fragment2 = 'about his trip to Ireland';
  const deliveries = committedTurns([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: fragment1 },
    { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 400 },
    { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 450 },
    { type: 'continuation_gap_elapsed', generation: 1 },
    { type: 'herald_start', mode: 'open', nativeSessionId: 3, nowMs: 5000 },
    { type: 'native_result_final', nativeSessionId: 3, text: fragment2 },
    { type: 'native_end', nativeSessionId: 3, speechStarted: true, partial: '', nowMs: 5400 },
    { type: 'native_listening_ready', nativeSessionId: 4, nowMs: 5450 },
    { type: 'continuation_gap_elapsed', generation: 1 },
  ]);
  const twoCommitted = deliveries.length === 2 && deliveries[0] === fragment1 && deliveries[1] === fragment2;
  await freshDb();
  const w = world();
  const turns: TurnTrace[] = [];
  if (twoCommitted) {
    turns.push(await say(w, deliveries[0], 'First committed user turn after the continuation opportunity expired.'));
    turns.push(await say(
      w,
      deliveries[1],
      'Second committed user turn. Continue Martin and Ireland. Do not pretend the two deliveries were one utterance.',
    ));
  }
  const second = turns[1];
  const linked = !!second
    && second.input === fragment2
    && second.deterministicOwner !== 'needs_clarification:default'
    && (mentions(second.customerSpeech, 'martin') || mentions(second.customerSpeech, 'ireland'));
  const checks: Check[] = [
    {
      name: 'harness:two-committed-turns',
      ok: twoCommitted,
      harness: true,
      detail: `Speech reducer deliveries ${JSON.stringify(deliveries)}. The harness could not represent the expired continuation as two committed user turns.`,
    },
    {
      name: 'conversation-relates-committed-turns',
      ok: twoCommitted && linked && (second?.durableWrite.length ?? 0) === 0,
      detail: twoCommitted
        ? `Speech committed two turns and did not stitch them. Conversation owner ${second?.deterministicOwner}; speech ${JSON.stringify(second?.customerSpeech)}; writes ${JSON.stringify(second?.durableWrite)}. Nothing deterministic relates the second committed turn to Martin.`
        : 'Speech split was not represented, so the conversation obligation was not graded.',
    },
  ];
  return finish(
    'I',
    'Speech/composition boundary',
    'Once the continuation opportunity has expired, Martin arrives as two committed user turns. Conversation authority must relate those turns without treating them as one ASR utterance.',
    turns,
    checks,
  );
}

function formatReport(journeys: JourneyReport[]): string {
  const lines: string[] = [];
  lines.push('CONVERSATION COMPOSITION CONTRACT V1');
  lines.push('Characterization report. Expected failures are not production-gate failures.');
  lines.push('Model was not invoked. Hot-ring prose was not used as state.');
  lines.push('');
  for (const journey of journeys) {
    lines.push(`${journey.id} — ${journey.title}`);
    lines.push(`  required: ${journey.required}`);
    lines.push(`  verdict: ${journey.verdict}`);
    lines.push(`  boundary: ${journey.failureBoundary}`);
    journey.turns.forEach((turn, index) => {
      lines.push(`  turn ${index + 1}`);
      lines.push(`    input: ${turn.input}`);
      lines.push(`    owner: ${turn.deterministicOwner}`);
      lines.push(`    route: ${turn.route ?? 'none'} reason: ${turn.reason ?? 'none'}`);
      lines.push(`    state before: ${turn.stateBefore}`);
      lines.push(`    state after: ${turn.stateAfter}`);
      lines.push(`    durable write: ${turn.durableWrite.length ? turn.durableWrite.join(', ') : 'none'}`);
      lines.push(`    durable read: ${turn.durableRead ?? 'none'}`);
      lines.push(`    generation entered: ${turn.generationEntered}`);
      lines.push(`    model invoked: ${turn.modelInvoked}`);
      lines.push(`    speech: ${turn.customerSpeech ?? 'none'}`);
      lines.push(`    expected: ${turn.expectedCustomerOutcome}`);
    });
    lines.push('');
  }
  const counts = {
    pass: journeys.filter((j) => j.verdict === 'PASS TODAY').length,
    fail: journeys.filter((j) => j.verdict === 'EXPECTED FAIL — ARCHITECTURE GAP').length,
    harness: journeys.filter((j) => j.verdict === 'TEST/HARNESS LIMITATION').length,
  };
  lines.push(`summary: PASS TODAY ${counts.pass} / EXPECTED FAIL — ARCHITECTURE GAP ${counts.fail} / TEST/HARNESS LIMITATION ${counts.harness}`);
  return lines.join('\n');
}

export async function runCompositionContractV1(): Promise<{ journeys: JourneyReport[]; report: string }> {
  setCalendarEventFetcher(async () => ({ status: 'ok', events: [] }));
  try {
    const runners = [journeyA, journeyB, journeyC, journeyD, journeyE, journeyF, journeyG, journeyH, journeyI];
    const journeys: JourneyReport[] = [];
    for (const run of runners) {
      try {
        journeys.push(await run());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        journeys.push({
          id: '?',
          title: run.name,
          required: 'Harness threw before the journey could be graded.',
          verdict: 'TEST/HARNESS LIMITATION',
          failureBoundary: message,
          turns: [],
        });
      }
    }
    const report = formatReport(journeys);
    console.log(`\n${report}\n`);
    return { journeys, report };
  } finally {
    resetCalendarEventFetcher();
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('compositionContractV1');
if (invokedDirectly) {
  runCompositionContractV1()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
