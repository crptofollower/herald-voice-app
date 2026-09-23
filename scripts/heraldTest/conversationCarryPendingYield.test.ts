// Conversation Carry V1 / Slice 1 — pending yield & preserve.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeMedicalRecord, attachVisitOutcome } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { CalendarContinuationHolder } from '../../src/routing/calendarContinuation.ts';
import { CalendarPresentationHolder } from '../../src/routing/calendarPresentation.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { CLARIFY_OPERATIONAL_LIST_KEY } from '../../src/routing/operationalListContinuity.ts';
import { CALL_TEXT_RECOVERY_KEY } from '../../src/routing/callTextReadiness.ts';
import type { CommitResult, RouteDecision } from '../../src/routing/routeIntent.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';
import {
  CARRY_SLICE1_DOCTOR_DISAMBIGUATE_KEY,
  CARRY_SLICE1_LLM_CONFIRM_KEY,
  CARRY_SLICE1_YES_NO_KEY,
  decideConversationCarryPendingYield,
  isConversationCarrySlice1PendingKey,
  conversationCarrySlice1OwnsReply,
} from '../../src/routing/pendingYieldPreserve.ts';
import { classifyRoutedEffect } from '../../src/routing/routedOperationEffect.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT, is_active INTEGER DEFAULT 1,
    notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id TEXT PRIMARY KEY, title TEXT, start_ms INTEGER, end_ms INTEGER,
    all_day INTEGER DEFAULT 0, notes TEXT, cached_at TEXT
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL, body TEXT NOT NULL,
    checked INTEGER DEFAULT 0, removed_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY,
    visit_date TEXT, doctor_name TEXT, facility TEXT, reason TEXT, diagnosis TEXT,
    follow_up TEXT, notes TEXT, status TEXT DEFAULT 'noted', surfaced_at TEXT,
    visit_outcome TEXT, outcome_asked_at TEXT, removed_at TEXT, created_at TEXT
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function groceryCount(db: Database.Database): number {
  return (db.prepare(
    `SELECT li.id FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'grocery' AND li.checked = 0 AND li.removed_at IS NULL`,
  ).all() as { id: string }[]).length;
}

function visitRows(db: Database.Database): { doctor_name: string | null }[] {
  return db.prepare(
    `SELECT doctor_name FROM medical_records WHERE removed_at IS NULL`,
  ).all() as { doctor_name: string | null }[];
}

function seedTwoDoctorOutcomes() {
  const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-06-01' });
  attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
  const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
  attachVisitOutcome(smithId, 'Smith said to continue the current dose.');
}

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO contacts (id, name, phone, created_at, updated_at) VALUES ('c1', 'Mickey', '5551112222', datetime('now'), datetime('now'))`,
  ).run();
  setDB(makeShim(db));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const medication = new MedicationPresentationHolder();
  const ordered = new OrderedPresentationHolder();
  const calendarPresentation = new CalendarPresentationHolder();
  const calendar = new CalendarContinuationHolder();
  const discourse = new DiscourseContinuityHolder();
  const classifyLLM = async (text: string) => {
    if (/saw dr\.?\s*smith/i.test(text)) {
      const intent: IntentRecord = { type: 'medical_visit', doctor_name: 'Dr. Smith', raw: text };
      return { status: 'ok' as const, intents: [intent] };
    }
    return { status: 'ok' as const, intents: [{ type: 'pass' as const }] };
  };
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM,
    llmReady: true,
    captureContext: { contacts: ['Mickey'] as string[], lists: ['grocery'] as string[] },
  };
  const say = (text: string) =>
    processUtterance(normalizeInput(text), session, deps, subject, medication, ordered, calendarPresentation, calendar, discourse);
  return { db, session, say };
}

function clockKind(outcome: Awaited<ReturnType<typeof processUtterance>>) {
  if (outcome.handled) return null;
  if (outcome.routeDecision.kind === 'device_action') return outcome.routeDecision.actionIntent.type;
  if (outcome.routeDecision.kind === 'device_read') return 'device_read';
  return outcome.routeDecision.kind;
}

export async function runConversationCarryPendingYieldV1Tests() {
  let passed = 0;
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
  function assert(label: string, cond: boolean, expected = 'true') {
    if (cond) {
      console.log(`${GREEN}PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}FAIL${RESET}  ${label}`);
      failures.push({ label, got: false, expected });
    }
  }

  console.log(`\n${BOLD}-- Conversation Carry V1 Slice 1 pending yield --------------${RESET}\n`);

  assert(
    'slice-1 keys are the three authorized representatives',
    isConversationCarrySlice1PendingKey(CARRY_SLICE1_YES_NO_KEY)
      && isConversationCarrySlice1PendingKey(CARRY_SLICE1_DOCTOR_DISAMBIGUATE_KEY)
      && isConversationCarrySlice1PendingKey(CARRY_SLICE1_LLM_CONFIRM_KEY)
      && !isConversationCarrySlice1PendingKey('llm_confirm:todo_add')
      && !isConversationCarrySlice1PendingKey(CLARIFY_OPERATIONAL_LIST_KEY)
      && !isConversationCarrySlice1PendingKey(CALL_TEXT_RECOVERY_KEY),
  );

  {
    const time: RouteDecision = {
      kind: 'device_action',
      actionIntent: { type: 'time', raw: 'What time is it?' },
      reason: 'action:time',
    };
    const sms: RouteDecision = {
      kind: 'device_action',
      actionIntent: { type: 'sms', contact: 'Mickey', message: "I'll be there at five.", raw: 'text' },
      reason: 'action:sms',
    };
    const miss: RouteDecision = { kind: 'needs_clarification', reason: 'default', response: '?' };
    assert('owned reply never yields', decideConversationCarryPendingYield({ ownsReply: true, decision: time }) === 'resume');
    assert(
      'medical_visit YES is owned by existing confirm vocabulary',
      conversationCarrySlice1OwnsReply({ pendingKey: CARRY_SLICE1_YES_NO_KEY, text: 'Yes.', sessionOwns: false }) === true,
    );
    assert('read_only preserves', decideConversationCarryPendingYield({ ownsReply: false, decision: time }) === 'preserve_read');
    assert('external_effect supersedes', decideConversationCarryPendingYield({ ownsReply: false, decision: sms }) === 'supersede');
    assert('ambiguous route stays fail-closed', decideConversationCarryPendingYield({ ownsReply: false, decision: miss }) === 'resume');
    assert('missing decision stays fail-closed', decideConversationCarryPendingYield({ ownsReply: false, decision: null }) === 'resume');
    assert('time effect is read_only', classifyRoutedEffect(time) === 'read_only');
    assert('sms effect is external_effect', classifyRoutedEffect(sms) === 'external_effect');
  }

  {
    const { db, session, say } = fresh();
    const arm = await say('I saw Dr. Smith yesterday.');
    assert('YES/NO medical_visit arms', arm.handled === true && session.peekPendingKey() === CARRY_SLICE1_YES_NO_KEY && visitRows(db).length === 0);
    const yes = await say('Yes.');
    assert('pending-owned YES still resumes medical_visit', yes.handled === true && yes.source === 'pending_resume' && session.peekPendingKey() === null);
    assert('YES writes once (no duplicate execution)', visitRows(db).length === 1 && visitRows(db)[0].doctor_name === 'Dr. Smith');
  }

  {
    const { db, session, say } = fresh();
    await say('I saw Dr. Smith yesterday.');
    const budget0 = session.peekPendingBudget();
    const cal = await say("What's on my calendar tomorrow?");
    assert(
      'calendar/read-only escapes medical_visit and preserves pending',
      clockKind(cal) === 'device_read' && session.peekPendingKey() === CARRY_SLICE1_YES_NO_KEY && session.peekPendingBudget() === budget0,
    );
    assert('calendar probe did not write a visit', visitRows(db).length === 0);
    const yes = await say('Yes.');
    assert('medical_visit still confirms after calendar', yes.source === 'pending_resume' && visitRows(db).length === 1);
  }

  {
    const { db, session, say } = fresh();
    await say('I saw Dr. Smith yesterday.');
    const sms = await say("Text Mickey and tell him I'll be there at five.");
    assert(
      'deterministic Text supersedes medical_visit',
      session.peekPendingKey() === null
        && !sms.handled
        && sms.routeDecision.kind === 'device_action'
        && sms.routeDecision.actionIntent.type === 'sms',
    );
    assert('supersede did not write the visit', visitRows(db).length === 0);
  }

  {
    const { db, session, say } = fresh();
    await say('I saw Dr. Smith yesterday.');
    const budget0 = session.peekPendingBudget();
    const prose = await say('the sky is blue today');
    assert(
      'unrelated ambiguous prose stays fail-closed on medical_visit',
      prose.handled === true && prose.source === 'pending_resume' && session.peekPendingKey() === CARRY_SLICE1_YES_NO_KEY,
    );
    assert('ambiguous prose consumed a retry, not a write', session.peekPendingBudget() === (budget0 ?? 2) - 1 && visitRows(db).length === 0);
  }

  {
    const { db, session, say } = fresh();
    await say('I saw Dr. Smith yesterday.');
    const no = await say('No.');
    assert('bare NO is unchanged', no.handled === true && no.source === 'pending_resume' && session.peekPendingKey() === null && visitRows(db).length === 0);
  }

  {
    const { db, session, say } = fresh();
    await say('I saw Dr. Smith yesterday.');
    const cancel = await say('Never mind.');
    assert('cancel is unchanged', cancel.handled === true && cancel.source === 'pending_resume' && session.peekPendingKey() === null && visitRows(db).length === 0);
  }

  {
    const { session, say } = fresh();
    seedTwoDoctorOutcomes();
    const ask = await say('What did my doctor tell me?');
    assert(
      'doctor disambiguation arms',
      ask.handled === true && session.peekPendingKey() === CARRY_SLICE1_DOCTOR_DISAMBIGUATE_KEY,
    );
    const resume = await say('Patel');
    assert(
      'pending-owned doctor name still resumes',
      resume.handled === true && resume.source === 'pending_resume' && /labs were unremarkable/.test(resume.responseText ?? '') && session.peekPendingKey() === null,
    );
  }

  {
    const { session, say } = fresh();
    seedTwoDoctorOutcomes();
    await say('What did my doctor tell me?');
    const time = await say('What time is it?');
    assert(
      'clock read preserves doctor disambiguation',
      clockKind(time) === 'time' && session.peekPendingKey() === CARRY_SLICE1_DOCTOR_DISAMBIGUATE_KEY,
    );
    const resume = await say('Patel');
    assert('doctor answer still works after clock', /labs were unremarkable/.test(resume.responseText ?? ''));
  }

  {
    const { session, say } = fresh();
    seedTwoDoctorOutcomes();
    await say('What did my doctor tell me?');
    const sms = await say("Text Mickey and tell him I'll be there at five.");
    assert(
      'deterministic Text supersedes doctor disambiguation',
      session.peekPendingKey() === null
        && !sms.handled
        && sms.routeDecision.kind === 'device_action'
        && sms.routeDecision.actionIntent.type === 'sms',
    );
  }

  {
    const { db, session, say } = fresh();
    let resumeCount = 0;
    session.setPending({
      pendingKey: CARRY_SLICE1_LLM_CONFIRM_KEY,
      resume: async (t: string): Promise<CommitResult> => {
        resumeCount += 1;
        if (/^yes\.?$/i.test(t.trim())) return { status: 'committed', ack: 'Saved.' };
        return { status: 'noop', ack: '' };
      },
      budget: 2,
    });
    const cal = await say("What's on my calendar tomorrow?");
    assert(
      'llm_confirm:list_add yields calendar read and preserves pending',
      clockKind(cal) === 'device_read' && session.peekPendingKey() === CARRY_SLICE1_LLM_CONFIRM_KEY && groceryCount(db) === 0 && resumeCount === 0,
    );
    const yes = await say('Yes.');
    assert('llm_confirm YES still resumes once', yes.source === 'pending_resume' && yes.responseText === 'Saved.' && session.peekPendingKey() === null && resumeCount === 1);
  }

  {
    const { session, say } = fresh();
    session.setPending({
      pendingKey: 'llm_confirm:todo_add',
      resume: async (): Promise<CommitResult> => ({ status: 'noop', ack: '' }),
      budget: 2,
    });
    const budget0 = session.peekPendingBudget();
    const time = await say('What time is it?');
    assert(
      'non-representative llm_confirm:todo_add still fail-closed',
      time.handled === true && time.source === 'pending_resume' && session.peekPendingKey() === 'llm_confirm:todo_add' && session.peekPendingBudget() === (budget0 ?? 2) - 1,
    );
  }

  {
    const { session, say } = fresh();
    const arm = await say('grab milk and eggs');
    const time = await say('What time is it?');
    assert(
      'existing clarify:* read-preserve unchanged',
      arm.handled === true && session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY && clockKind(time) === 'time',
    );
  }

  {
    const { session, say } = fresh();
    session.setPending({
      pendingKey: CALL_TEXT_RECOVERY_KEY,
      resume: async (): Promise<CommitResult> => ({ status: 'noop', ack: '' }),
      ownsReply: () => false,
      budget: 2,
    });
    const timer = await say('set a timer for 5 minutes');
    assert(
      'existing call_text_recovery still yields competing action',
      session.peekPendingKey() === null
        && (!timer.handled && timer.routeDecision.kind === 'device_action' && timer.routeDecision.actionIntent.type === 'timer'),
    );
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('conversationCarryPendingYield.test.ts')) {
  runConversationCarryPendingYieldV1Tests().then((r) => {
    console.log(`\n${BOLD}ConversationCarryPendingYieldV1: ${r.passed} passed, ${r.failed} failed${RESET}\n`);
    process.exit(r.failed ? 1 : 0);
  });
}
