// Conversational Evidence Admission V1 + Active Subject preservation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { DiscourseContinuityHolder, qualifyingNarrativePersonNames } from '../../src/routing/discourseContinuity.ts';
import { createConversationTurnLedger, CONVERSATION_TURN_LEDGER_TTL_MS } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnLedger, ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import { ledgerFocusWithConversationalTopic } from '../../src/routing/conversationTurnLedgerWrite.ts';
import {
  canonicalConversationalEvidence,
  conversationalTurnFocus,
} from '../../src/routing/conversationalEvidence.ts';
import {
  answerActiveSubjectReference,
  projectNarrativePersons,
  ACTIVE_SUBJECT_GROUNDING_ACK,
} from '../../src/routing/activeSubjectReference.ts';
import { answerImmediateSemanticRecap } from '../../src/routing/immediateSemanticRecap.ts';
import { establishHardPending } from '../../src/routing/hardPendingBoundary.ts';
import { RecoveryObligationHolder } from '../../src/routing/recoveryObligation.ts';
import { correctionSpeech } from '../../src/routing/discourseCorrection.ts';
import { DISCOURSE_MENTION_PROPOSAL_PROMPT } from '../../src/routing/semanticProvider.ts';
import {
  EVIDENCE_ACK_REPLY,
  isBareZeroEvidenceOpeningFragment,
  resolveEphemeralSeam,
} from '../../src/utils/ephemeralSeam.ts';
import type { DiscourseMention } from '../../src/routing/discourseContinuity.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const DALLAS = 'He lives in Dallas.';
const FORD = 'He works at Ford.';
const AUSTIN = 'She moved to Austin.';
const MARCH = "I'm leaving in March.";
const DENVER = 'My sister lives in Denver.';
const IRELAND = 'Martin is going to Ireland.';
const SKY = 'The sky looks grey today.';
const HARBOR = 'North Harbor is nearby.';
const ALPHA = 'Alpha Beta are wonderful.';
const MARTIN = 'I talked with Martin yesterday.';
const ROUTE = { kind: 'needs_clarification' as const, reason: 'default' };
const BACKEND = { kind: 'backend' as const };

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function rowCounts(db: Database.Database): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number };
    out[table.name] = row.n;
  }
  return out;
}

async function openDb() {
  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  return db;
}

function deps(interpreter: 'off' | 'on' | 'person', llmStatus: 'unavailable' | 'loading' | 'ready' | 'error' = 'unavailable') {
  return {
    classifyQuery,
    classifyLLM: null,
    llmReady: llmStatus === 'ready',
    llmStatus,
    getMedicationSemanticInterpreterCtx: () => {
      if (interpreter === 'off') return null;
      return {
        completion: async (params: { prompt?: string }) => {
          const prompt = params.prompt ?? '';
          if (interpreter === 'person' && prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)) {
            const utterance = prompt.slice(DISCOURSE_MENTION_PROPOSAL_PROMPT.length).trim();
            const names = qualifyingNarrativePersonNames(utterance);
            return { text: JSON.stringify(names.map((span) => ({ span, kind: 'person' }))) };
          }
          if (interpreter === 'on' && prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)) {
            return { text: JSON.stringify([{ span: 'Dallas', kind: 'place' }]) };
          }
          return { text: '[]' };
        },
      };
    },
  };
}

function mention(partial: Partial<DiscourseMention> & Pick<DiscourseMention, 'mentionId' | 'surfaceSpan' | 'status'>): DiscourseMention {
  return {
    kind: 'person',
    start: 0,
    end: partial.surfaceSpan.length,
    sourceTurnId: 1,
    sourceUtteranceRef: 'turn:1',
    epistemic: 'current_conversation',
    durable: false,
    ...partial,
  };
}

function record(partial: Partial<ConversationTurnRecord> & Pick<ConversationTurnRecord, 'utterance' | 'focus'>): ConversationTurnRecord {
  return {
    turnIndex: 1,
    establishedAt: Date.now(),
    intentType: null,
    operation: 'conversational',
    outcome: 'presented',
    authorityTier: 'conversational',
    assistantReplySummary: null,
    ...partial,
  };
}

async function seam(text: string, llmStatus: 'unavailable' | 'loading' | 'ready' | 'error', admitted: boolean, generateText = 'Sounds right.') {
  let generateCalled = false;
  const outcome = await resolveEphemeralSeam({
    text,
    reason: 'default',
    hasAuthorizedContinuation: false,
    hasPendingSession: false,
    hasContactCollectPending: false,
    rdTier: 3,
    hasStructuredCaptures: false,
    isPersonalCaptureRisk: false,
    llmStatus,
    classifierBusy: false,
    ephemeralBusy: false,
    conversationalEvidenceAdmitted: admitted,
    generate: async () => {
      generateCalled = true;
      if (llmStatus !== 'ready') return { status: 'unavailable', reason: 'no-ctx' };
      return { status: 'ok', text: generateText };
    },
  });
  return { outcome, generateCalled };
}

function pushAdmitted(
  ledger: ConversationTurnLedger,
  utterance: string,
  route: { kind: string; reason?: string; readMeta?: unknown },
  outcome: 'presented' | 'generated' | 'declined',
  narrativePersonMentionId?: string,
) {
  return ledger.push({
    establishedAt: Date.now(),
    utterance,
    intentType: null,
    operation: 'conversational',
    outcome,
    authorityTier: 'conversational',
    assistantReplySummary: outcome === 'generated' ? 'Sounds right.' : 'Okay.',
    focus: ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance,
      routeDecision: route,
    }),
    ...(narrativePersonMentionId ? { narrativePersonMentionId } : {}),
  });
}

export async function runConversationalEvidenceAdmissionTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, expected: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }
  function assertTrue(label: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}`); failures.push({ label, got: cond, expected: 'true' }); }
  }

  console.log(`\n${BOLD}-- Conversational Evidence Admission V1 ----------------------${RESET}\n`);

  {
    const db = await openDb();
    const before = rowCounts(db);
    for (const utterance of [DALLAS, FORD, AUSTIN]) {
      const session = new ConversationSession();
      const ledger = createConversationTurnLedger();
      const outcome = await processUtterance(utterance, session, deps('off'), null, null, null, null, null, null, ledger);
      assertTrue(`${utterance} stays unhandled with models off`, outcome.handled === false);
      assert(`${utterance} evidence is the full utterance`, outcome.handled ? null : outcome.conversationalEvidence?.displayValue, utterance);
      pushAdmitted(ledger, utterance, outcome.handled ? ROUTE : outcome.routeDecision, 'presented');
      const topics = ledger.peek(Date.now()).flatMap((entry) => entry.focus).filter((entry) => entry.kind === 'topic');
      assert(`${utterance} topic count is 1`, topics.length, 1);
      assertTrue(`${utterance} writes no person focus`, ledger.peek(Date.now()).every((entry) => entry.focus.every((focus) => focus.kind !== 'person')));
    }
    for (const utterance of [MARCH, DENVER, IRELAND]) {
      const evidence = canonicalConversationalEvidence(utterance, ROUTE);
      assert(`${utterance} evidence is the full utterance`, evidence?.displayValue, utterance);
    }
    assert('sqlite delta is zero', rowCounts(db), before);
  }

  {
    const ready = await seam(MARCH, 'ready', true, 'March can be a full month.');
    assert('Qwen success stays generated', ready.outcome.kind, 'generative');
    assert('Qwen success keeps the generated reply', ready.outcome.reply, 'March can be a full month.');
    const focus = ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance: MARCH,
      routeDecision: ROUTE,
    });
    assert('generated path still carries the canonical topic', focus[0]?.displayValue, MARCH);
    const bare = await seam('Yeah that seems fine', 'ready', false);
    assertTrue('four-word zero-evidence fragment blocks generation', isBareZeroEvidenceOpeningFragment('Yeah that seems fine') && bare.generateCalled === false && bare.outcome.kind === 'clarify');
    const unlabeled = ['The Lanterns.', 'Alpha Beta.', 'the blue ridge mountains'];
    for (const utterance of unlabeled) {
      const evidence = canonicalConversationalEvidence(utterance, ROUTE);
      const gated = await seam(utterance, 'ready', false);
      assert(`${utterance} is not evidence`, evidence, null);
      assert(`${utterance} stays clarify`, gated.outcome.kind, 'clarify');
    }
    const harbor = await seam(HARBOR, 'ready', true, 'I remember living there.');
    assertTrue('North Harbor does not generate prose', harbor.generateCalled === false && harbor.outcome.kind === 'evidence_ack' && harbor.outcome.reply === EVIDENCE_ACK_REPLY);
    const alpha = await seam(ALPHA, 'ready', true);
    assert('Alpha Beta proposition is evidence ack', alpha.outcome.kind, 'evidence_ack');
    assert('question is not admitted', canonicalConversationalEvidence("What's the weather in Dallas?", ROUTE), null);
    assert('imperative is not admitted', canonicalConversationalEvidence('Call Martin.', ROUTE), null);
    const called = canonicalConversationalEvidence('I called.', ROUTE);
    const leaving = canonicalConversationalEvidence("I'm leaving.", ROUTE);
    assert('I called. is admitted whole', called?.displayValue, 'I called.');
    assert("I'm leaving. is admitted whole", leaving?.displayValue, "I'm leaving.");
  }

  {
    const db = await openDb();
    const before = rowCounts(db);
    const session = new ConversationSession();
    establishHardPending(session, {
      pendingKey: 'llm_confirm:todo_add',
      resume: async () => ({ status: 'noop', ack: '' }),
    });
    const ledger = createConversationTurnLedger();
    const pending = await processUtterance(DALLAS, session, deps('off'), null, null, null, null, null, null, ledger);
    assertTrue('pending owns the turn', pending.handled === true && pending.source === 'pending_resume');
    assertTrue('pending writes no conversational topic', ledger.peek(Date.now()).every((entry) => entry.focus.every((focus) => focus.displayValue !== DALLAS)));
    const recovery = new RecoveryObligationHolder();
    recovery.establish();
    const recovered = await processUtterance("that's not what I meant", new ConversationSession(), deps('off'), null, null, null, null, null, null, ledger, null, recovery);
    assertTrue('recovery owns the repair', recovered.handled === true && recovered.source === 'recovery_obligation');
    assertTrue('recovery writes no conversational topic', ledger.peek(Date.now()).every((entry) => entry.utterance !== "that's not what I meant"));
    assert('pending and recovery write no rows', rowCounts(db), before);
  }

  {
    for (const interpreter of ['on', 'off'] as const) {
      const db = await openDb();
      const before = rowCounts(db);
      const ledger = createConversationTurnLedger();
      const session = new ConversationSession();
      const discourse = new DiscourseContinuityHolder();
      const first = await processUtterance(DALLAS, session, deps(interpreter), null, null, null, null, null, discourse, ledger);
      assertTrue(`Dallas interpreter ${interpreter} is evidence`, first.handled === false && first.conversationalEvidence?.displayValue === DALLAS);
      pushAdmitted(ledger, DALLAS, first.handled ? ROUTE : first.routeDecision, 'presented', first.handled ? undefined : first.narrativePersonMentionId);
      const asked = await processUtterance('Sorry, Austin.', session, deps(interpreter), null, null, null, null, null, discourse, ledger);
      assert(`Dallas correction ${interpreter} asks`, asked.handled ? asked.responseText : '', 'Austin instead of Dallas?');
      const yes = await processUtterance('Yes', session, deps(interpreter), null, null, null, null, null, discourse, ledger);
      assert(`Dallas correction ${interpreter} confirms`, yes.handled ? yes.responseText : '', correctionSpeech('event_or_topic', 'Austin'));
      assert(`Dallas correction ${interpreter} revises the full utterance`, ledger.peek(Date.now()).at(-1)?.focus[0]?.displayValue, 'He lives in Austin.');
      assert(`Dallas correction ${interpreter} writes no rows`, rowCounts(db), before);
    }
  }

  {
    const ledger = createConversationTurnLedger();
    pushAdmitted(ledger, DALLAS, ROUTE, 'presented');
    const recap = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('recap reads the admitted topic', recap.handled === true && recap.kind === 'conversational_recap' && recap.reply.includes(DALLAS.replace(/[.?!]+$/, '')));
  }

  {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const src = fs.readFileSync(path.join(root, 'src/routing/conversationalEvidence.ts'), 'utf8');
    const specs = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
    assertTrue('admission module imports no LLM, B2, semantic, or database module', specs.every((spec) => !/llama|sqlite|\/db\/|semantic|b2|qwen/i.test(spec)));
    const weather = canonicalConversationalEvidence("What's the weather in Dallas?", BACKEND);
    const weatherFocus = ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance: "What's the weather in Dallas?",
      routeDecision: BACKEND,
    });
    assert('offline weather question has no evidence', weather, null);
    assert('offline weather question has no topic', weatherFocus, []);
    const offlineDeclarative = ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance: DALLAS,
      routeDecision: BACKEND,
    });
    assert('offline admitted declarative keeps the canonical topic', offlineDeclarative[0]?.displayValue, DALLAS);
    const chat = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
    assertTrue('offline canned path still declines', chat.includes("let ledgerOutcome: 'declined' | 'clarified' | 'generated' | 'presented' = 'declined'"));
  }

  console.log(`\n${BOLD}-- Model-state invariance -----------------------------------${RESET}\n`);
  {
    const utterances = [DALLAS, MARCH, DENVER, HARBOR];
    const states = [
      { interpreter: 'on' as const, qwen: 'ready' as const },
      { interpreter: 'off' as const, qwen: 'ready' as const },
      { interpreter: 'on' as const, qwen: 'unavailable' as const },
      { interpreter: 'off' as const, qwen: 'unavailable' as const },
    ];
    for (const utterance of utterances) {
      const displays: string[] = [];
      for (const state of states) {
        const session = new ConversationSession();
        const outcome = await processUtterance(utterance, session, deps(state.interpreter, state.qwen));
        const display = outcome.handled ? '' : outcome.conversationalEvidence?.displayValue ?? '';
        displays.push(display);
        const admitted = display === utterance;
        const gated = await seam(utterance, state.qwen, admitted);
        const ledger = createConversationTurnLedger();
        if (!outcome.handled) {
          pushAdmitted(ledger, utterance, outcome.routeDecision, gated.outcome.kind === 'generative' ? 'generated' : gated.outcome.kind === 'evidence_ack' ? 'presented' : 'declined');
        }
        const topics = ledger.peek(Date.now()).flatMap((entry) => entry.focus).filter((entry) => entry.kind === 'topic');
        const people = ledger.peek(Date.now()).flatMap((entry) => entry.focus).filter((entry) => entry.kind === 'person');
        assert(`${utterance} ${state.interpreter}/${state.qwen} topic display`, topics[0]?.displayValue, utterance);
        assert(`${utterance} ${state.interpreter}/${state.qwen} topic count`, topics.length, 1);
        assert(`${utterance} ${state.interpreter}/${state.qwen} person focus count`, people.length, 0);
        assertTrue(`${utterance} ${state.interpreter}/${state.qwen} topic has no resolver key`, topics[0]?.resolverKey === undefined);
      }
      assertTrue(`${utterance} display is identical in every model state`, displays.every((display) => display === utterance));
    }
    const loadingSeam = await seam(DALLAS, 'loading', true);
    const errorSeam = await seam(DALLAS, 'error', true);
    assert('loading still acknowledges admitted evidence', loadingSeam.outcome.kind, 'evidence_ack');
    assert('error still acknowledges admitted evidence', errorSeam.outcome.kind, 'evidence_ack');
    assert('loading does not erase the canonical topic', ledgerFocusWithConversationalTopic([], {
      operation: 'conversational', utterance: DALLAS, routeDecision: ROUTE,
    })[0]?.displayValue, DALLAS);
    const errored = await processUtterance(DALLAS, new ConversationSession(), deps('off', 'error'));
    assert('error does not erase evidence', errored.handled ? null : errored.conversationalEvidence?.displayValue, DALLAS);
    const unadmitted = ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance: 'The Lanterns.',
      routeDecision: ROUTE,
    });
    assert('generation is not an admission rule', unadmitted, []);
  }

  console.log(`\n${BOLD}-- Active Subject preservation AS1–AS12 ---------------------${RESET}\n`);
  {
    const db = await openDb();
    const before = rowCounts(db);
    const session = new ConversationSession();
    const ledger = createConversationTurnLedger();
    const discourse = new DiscourseContinuityHolder();
    const established = await processUtterance(MARTIN, session, deps('person'), null, null, null, null, null, discourse, ledger);
    assertTrue('AS1 no ledger person focus from 3B', established.handled === false && established.continuityFocus === undefined);
    assertTrue('AS2 annotation exists', established.handled === false && typeof established.narrativePersonMentionId === 'string');
    const mentionId = established.handled ? '' : established.narrativePersonMentionId ?? '';
    pushAdmitted(ledger, MARTIN, established.handled ? ROUTE : established.routeDecision, 'presented', mentionId);
    const stored = ledger.peek(Date.now()).at(-1)!;
    assertTrue('AS2 annotation is stored and is not focus', stored.narrativePersonMentionId === mentionId && stored.focus.every((entry) => entry.kind !== 'person'));
    const who = await answerActiveSubjectReference('Who was I talking about?', {
      ledgerEntries: ledger.peek(Date.now()),
      discourseMentions: discourse.peekDiscourseMentions(),
    });
    assert('AS3 closed identity is preserved', who.handled && who.kind === 'identity' ? who.reply : '', 'You were talking about Martin.');
    const said = await answerActiveSubjectReference('What did I say about him?', {
      ledgerEntries: ledger.peek(Date.now()),
      discourseMentions: discourse.peekDiscourseMentions(),
    });
    assert('AS4 content lookup is preserved', said.handled && said.kind === 'content' ? said.reply : '', `You said: "${MARTIN}"`);
    const grounded = await answerActiveSubjectReference("He's moving to Austin.", {
      ledgerEntries: ledger.peek(Date.now()),
      discourseMentions: discourse.peekDiscourseMentions(),
    });
    assert('AS5 grounding reply stays Okay', grounded.handled && grounded.kind === 'grounding' ? grounded.reply : '', ACTIVE_SUBJECT_GROUNDING_ACK);
    assertTrue('AS5 grounding writes no person focus', grounded.handled && grounded.kind === 'grounding' && grounded.focus.length === 0);
    assert('AS5 grounding carries the mention annotation', grounded.handled && grounded.kind === 'grounding' ? grounded.narrativePersonMentionId : '', mentionId);
    const doctor = record({
      turnIndex: 1,
      utterance: 'I saw Dr. Smith today.',
      focus: [{ kind: 'person', displayValue: 'Dr. Smith', resolverKey: 'Dr. Smith', referable: true, tier: 'deterministic_unconfirmed' }],
    });
    const narrative = record({
      turnIndex: 2,
      utterance: MARTIN,
      narrativePersonMentionId: mentionId,
      focus: [{ kind: 'topic', displayValue: MARTIN, referable: true, tier: 'conversational' }],
    });
    const mixed = await answerActiveSubjectReference('Who was I talking about?', {
      ledgerEntries: [doctor, narrative],
      discourseMentions: discourse.peekDiscourseMentions(),
    });
    assertTrue('AS6 mixed deterministic and narrative people clarify', mixed.handled === true && mixed.kind === 'ambiguous' && /Dr\. Smith/.test(mixed.handled ? mixed.reply : '') && /Martin/.test(mixed.handled ? mixed.reply : ''));
    const corrected = mention({ mentionId, surfaceSpan: 'Martin', status: 'corrected_away' });
    const gone = projectNarrativePersons([narrative], [corrected]);
    assertTrue('AS7 corrected-away narrative person is not projected', gone[0]?.focus.every((entry) => entry.kind !== 'person') === true);
    const superseded = mention({ mentionId, surfaceSpan: 'Martin', status: 'superseded' });
    const replaced = projectNarrativePersons([narrative], [superseded]);
    assertTrue('AS8 superseded narrative person is not projected', replaced[0]?.focus.every((entry) => entry.kind !== 'person') === true);
    const stale = projectNarrativePersons([{ ...narrative, establishedAt: Date.now() - CONVERSATION_TURN_LEDGER_TTL_MS - 1000 }], discourse.peekDiscourseMentions());
    assertTrue('AS9 stale narrative person is not projected', stale[0]?.focus.every((entry) => entry.kind !== 'person') === true);
    const missing = projectNarrativePersons([narrative], []);
    assertTrue('AS9 missing mention is not projected', missing[0]?.focus.every((entry) => entry.kind !== 'person') === true);
    const projected = projectNarrativePersons([narrative], discourse.peekDiscourseMentions());
    const synthetic = projected[0]?.focus.find((entry) => entry.kind === 'person');
    assertTrue('AS11 synthetic person has no resolver key', synthetic?.resolverKey === undefined && synthetic?.discourseMentionIds?.[0] === mentionId && synthetic?.tier === 'conversational');
    assert('AS12 sqlite stays unchanged', rowCounts(db), before);
    writeMedicalRecord({ doctor_name: 'Dr Smith', visit_date: '2026-08-01', status: 'noted' });
    const visit = await processUtterance('What was my last visit with Dr Smith?', new ConversationSession(), deps('off'), new ConversationalSubjectHolder());
    assertTrue('AS12 doctor focus stays deterministic', visit.handled === false && visit.continuityFocus?.kind === 'person' && /smith/i.test(visit.continuityFocus.displayValue) && typeof visit.continuityFocus.resolverKey === 'string' && visit.narrativePersonMentionId === undefined);
    const built = conversationalTurnFocus({
      evidence: { displayValue: DALLAS },
      retainedFocus: [],
      discourseMentionIds: ['m1'],
    });
    assert('canonical builder keeps one full-utterance topic', built, [{
      kind: 'topic',
      displayValue: DALLAS,
      referable: true,
      tier: 'conversational',
      discourseMentionIds: ['m1'],
    }]);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationalEvidenceAdmission: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationalEvidenceAdmission.test.ts')) {
  runConversationalEvidenceAdmissionTests();
}
