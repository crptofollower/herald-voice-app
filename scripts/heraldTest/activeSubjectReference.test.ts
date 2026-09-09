// scripts/heraldTest/activeSubjectReference.test.ts
// Active Subject / Reference Continuity V1 — CTO acceptance suite.
//
// Proves the approved journey end-to-end: establish Dr. Smith through an
// existing trustworthy path -> natural referential continuation grounds as
// RAM-only conversational evidence, never authoritative -> later identity/
// content reference questions (including held-out wording never encoded as
// production grammar) resolve from that evidence -> genuine ambiguity uses
// existing ConversationSession pending authority, never a silent pick ->
// none of this ever writes to SQLite except the one expected establishment.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import {
  answerActiveSubjectReference,
  resolveActiveSubjectCandidate,
  ACTIVE_SUBJECT_GROUNDING_ACK,
} from '../../src/routing/activeSubjectReference.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { continuityLedgerFocus } from '../../src/routing/conversationTurnLedgerWrite.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import { classifyImmediateRecapDeterministic, answerImmediateSemanticRecap } from '../../src/routing/immediateSemanticRecap.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT,
    is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT,
    status TEXT DEFAULT 'noted', surfaced_at TEXT, visit_outcome TEXT,
    outcome_asked_at TEXT, removed_at TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, specialty TEXT, phone TEXT,
    address TEXT, is_primary INTEGER DEFAULT 0, notes TEXT, created_at TEXT,
    removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL, body TEXT NOT NULL,
    checked INTEGER DEFAULT 0, removed_at TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY (list_id) REFERENCES lists(id)
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

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [] as string[], lists: [] as string[] },
  };
  return { db, session, deps };
}

function medicalRecordsCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as n FROM medical_records').get() as any).n;
}

const activeSubjectModulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/routing/activeSubjectReference.ts',
);

/** Captures HERALD_ACTIVE_SUBJECT_DIAG events emitted during `fn`, restores
 *  console.warn unconditionally afterward (even on throw) — same technique
 *  as immediateSemanticRecapDiagnostics.test.ts's captureDiagEvents. */
async function captureActiveSubjectDiagEvents<T>(fn: () => Promise<T>): Promise<{ result: T; events: any[] }> {
  const original = console.warn;
  const rawLines: string[] = [];
  console.warn = (...args: unknown[]) => { rawLines.push(args.map((a) => String(a)).join(' ')); };
  try {
    const result = await fn();
    const events = rawLines
      .filter((l) => l.startsWith('HERALD_ACTIVE_SUBJECT_DIAG '))
      .map((l) => JSON.parse(l.slice('HERALD_ACTIVE_SUBJECT_DIAG '.length)));
    return { result, events };
  } finally {
    console.warn = original;
  }
}

function rec(overrides: Partial<ConversationTurnRecord> & { focus: ConversationTurnRecord['focus'] }): ConversationTurnRecord {
  return {
    turnIndex: 1,
    establishedAt: Date.now(),
    utterance: 'x',
    intentType: null,
    operation: 'capture',
    outcome: 'committed',
    authorityTier: 'deterministic',
    assistantReplySummary: null,
    ...overrides,
  };
}

export async function runActiveSubjectReferenceTests() {
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

  const establishDrSmith = rec({
    turnIndex: 1,
    utterance: 'I saw Dr. Smith today.',
    intentType: 'medical_visit',
    focus: [{ kind: 'person', displayValue: 'Dr. Smith', resolverKey: 'Dr. Smith', referable: true, tier: 'authoritative' }],
  });

  console.log(`\n${BOLD}-- Referential grounding: "He wants me to come back next month." grounds to Dr. Smith --${RESET}`);
  {
    const outcome = await answerActiveSubjectReference('He wants me to come back next month.', { ledgerEntries: [establishDrSmith] });
    assertTrue('grounding: handled', outcome.handled === true);
    assert('grounding: kind', outcome.handled ? outcome.kind : null, 'grounding');
    // CTO correction: successful grounding must not leave the canned
    // misunderstanding reply standing — it now speaks a minimal, neutral
    // acknowledgment that implies nothing about persistence.
    assert('grounding: replies with the minimal neutral acknowledgment', outcome.handled && outcome.kind === 'grounding' ? outcome.reply : null, ACTIVE_SUBJECT_GROUNDING_ACK);
    assertTrue('grounding: ack never implies persistence ("remember"/"saved")', outcome.handled && outcome.kind === 'grounding' && !/remember|saved|save/i.test(outcome.reply));
    assertTrue('grounding: ack never states the proposition as fact ("Dr. Smith wants...")', outcome.handled && outcome.kind === 'grounding' && !/dr\. smith/i.test(outcome.reply));
    assertTrue('grounding: exactly one focus entry', outcome.handled && outcome.kind === 'grounding' && outcome.focus.length === 1);
    assert('grounding: tier is conversational, never authoritative', outcome.handled && outcome.kind === 'grounding' ? outcome.focus[0]?.tier : null, 'conversational');
    assert('grounding: resolverKey preserved from the established candidate', outcome.handled && outcome.kind === 'grounding' ? outcome.focus[0]?.resolverKey : null, 'Dr. Smith');
    assertTrue('grounding: no candidate -> handled false (nothing to ground)', (await answerActiveSubjectReference('He wants me to come back next month.', { ledgerEntries: [] })).handled === false);
  }

  const groundingRecord = rec({
    turnIndex: 2,
    utterance: 'He wants me to come back next month.',
    intentType: null,
    operation: 'conversational',
    outcome: 'declined',
    authorityTier: 'conversational',
    focus: [{ kind: 'person', displayValue: 'Dr. Smith', resolverKey: 'Dr. Smith', referable: true, tier: 'conversational' }],
  });
  const ledgerAfterGrounding = [establishDrSmith, groundingRecord];

  console.log(`\n${BOLD}-- Later continuity: identity and content questions resolve from the actual conversation relationship --${RESET}`);
  {
    const idOutcome = await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: ledgerAfterGrounding });
    assertTrue('identity: handled', idOutcome.handled === true);
    assert('identity: kind', idOutcome.handled ? idOutcome.kind : null, 'identity');
    assertTrue('identity: names Dr. Smith', idOutcome.handled && idOutcome.kind === 'identity' && idOutcome.reply.includes('Dr. Smith'));

    const contentOutcome = await answerActiveSubjectReference('What was I saying about him?', { ledgerEntries: ledgerAfterGrounding });
    assertTrue('content: handled', contentOutcome.handled === true);
    assert('content: kind', contentOutcome.handled ? contentOutcome.kind : null, 'content');
    assertTrue(
      'content: retrieves the actual grounded statement, not just the establishment turn',
      contentOutcome.handled && contentOutcome.kind === 'content' && contentOutcome.reply.includes('come back next month'),
    );
  }

  console.log(`\n${BOLD}-- Held-out Stage B proof: "Who did I mean there?" succeeds without being production grammar --${RESET}`);
  {
    const paulRecord = rec({
      turnIndex: 3,
      utterance: 'Paul drove me there.',
      focus: [{ kind: 'person', displayValue: 'Paul', resolverKey: 'Paul', referable: true, tier: 'conversational' }],
    });
    const ledgerTwoCandidates = [establishDrSmith, paulRecord];
    let ctxCalls = 0;
    // "Who did I mean there?" matches only the broad, verb-agnostic
    // structural pre-filter (isPlausibleReferenceQuestionShape), not either
    // closed Stage-A pattern — so act applicability itself is unconfirmed,
    // and the model's proposal must now also say applicable:true (the fast
    // path is never used here even though exactly one candidate index is
    // being requested by the mock's own list — two candidates are live).
    const mockCtx = {
      completion: async () => { ctxCalls++; return { text: '{"applicable":true,"selectedIndex":1,"ambiguous":false,"confidence":0.9}' }; },
    } as any;
    const heldOutOutcome = await answerActiveSubjectReference('Who did I mean there?', {
      ledgerEntries: ledgerTwoCandidates,
      getInterpreterCtx: () => mockCtx,
    });
    assertTrue('held-out: Stage B was actually invoked', ctxCalls === 1);
    assertTrue('held-out: handled', heldOutOutcome.handled === true);
    assert('held-out: kind', heldOutOutcome.handled ? heldOutOutcome.kind : null, 'identity');
    assertTrue('held-out: resolves correctly via Stage B', heldOutOutcome.handled && heldOutOutcome.kind === 'identity' && heldOutOutcome.reply.includes('Dr. Smith'));

    // Structural proof, not a bare word search (the module's own comments
    // legitimately discuss why these words are excluded from matching): no
    // regex literal anywhere in the file contains "mean" or "discuss".
    const src = fs.readFileSync(activeSubjectModulePath, 'utf8');
    const regexLiterals = src.match(/\/(?:[^\n\/\\]|\\.)+\/[a-z]*/g) ?? [];
    assertTrue(
      'held-out: no regex literal in source matches on "mean" or "discuss"',
      regexLiterals.every((r) => !/mean|discuss/i.test(r)),
    );
  }

  console.log(`\n${BOLD}-- Fail closed on non-reference questions: candidate existence alone never grants handling --${RESET}`);
  {
    // Single live person candidate — exactly the shape that could tempt a
    // naive "candidate exists -> handle it" mechanism into the steal class
    // the CTO flagged. None of these are added to production regex; each
    // is rejected either by the outer structural pre-filter or by the
    // semantic stage's own applicable:false judgment.
    const ledgerOneCandidate = [establishDrSmith];
    const notApplicableCtx = {
      completion: async () => ({ text: '{"applicable":false,"selectedIndex":null,"ambiguous":false,"confidence":0.9}' }),
    } as any;

    let calls = 0;
    const countingNotApplicableCtx = {
      completion: async () => { calls++; return { text: '{"applicable":false,"selectedIndex":null,"ambiguous":false,"confidence":0.9}' }; },
    } as any;

    const negative1 = await answerActiveSubjectReference('What did I ask the doctor?', {
      ledgerEntries: ledgerOneCandidate, getInterpreterCtx: () => notApplicableCtx,
    });
    assertTrue('negative: "What did I ask the doctor?" -> handled false (Stage B said not applicable)', negative1.handled === false);

    const { result: negative2, events: negative2Events } = await captureActiveSubjectDiagEvents(() =>
      answerActiveSubjectReference('When is my appointment?', { ledgerEntries: ledgerOneCandidate, getInterpreterCtx: () => countingNotApplicableCtx }),
    );
    assertTrue('negative: "When is my appointment?" -> handled false', negative2.handled === false);
    assertTrue('negative: "When is my appointment?" is rejected by the outer structural gate (not a who/what/which start) — Stage B never even consulted', calls === 0);
    assert('negative: diag event shows semantic stage never invoked for this one', negative2Events[0]?.semanticStageInvoked, false);

    const negative3 = await answerActiveSubjectReference('What medications am I taking?', {
      ledgerEntries: ledgerOneCandidate, getInterpreterCtx: () => notApplicableCtx,
    });
    assertTrue('negative: "What medications am I taking?" -> handled false (Stage B said not applicable)', negative3.handled === false);

    const negative4 = await answerActiveSubjectReference('What am I allergic to?', {
      ledgerEntries: ledgerOneCandidate, getInterpreterCtx: () => notApplicableCtx,
    });
    assertTrue('negative: "What am I allergic to?" -> handled false (Stage B said not applicable)', negative4.handled === false);

    // Fail-closed proof: with a live compatible candidate AND a structurally
    // plausible shape, but NO interpreter available to confirm applicability,
    // the mechanism must still refuse to handle — never fall back to
    // treating candidate existence alone as sufficient.
    const noInterpreter = await answerActiveSubjectReference('What did I ask the doctor?', { ledgerEntries: ledgerOneCandidate });
    assertTrue('negative (no interpreter): fails CLOSED, not ambiguous, not a silent answer', noInterpreter.handled === false);

    // Positive retention proof, side by side with the negatives above: the
    // SAME broad gate still lets genuine unseen reference language through
    // when the semantic stage confirms applicability.
    const positiveCtx = {
      completion: async () => ({ text: '{"applicable":true,"selectedIndex":0,"ambiguous":false,"confidence":0.9}' }),
    } as any;
    const positive = await answerActiveSubjectReference('Which person were we discussing?', {
      ledgerEntries: ledgerOneCandidate, getInterpreterCtx: () => positiveCtx,
    });
    assertTrue('positive: unseen wording still succeeds when Stage B confirms applicable:true', positive.handled === true && positive.kind === 'identity');
  }

  console.log(`\n${BOLD}-- Competing person: not-newest-wins --${RESET}`);
  {
    const drSmithFirst = rec({
      turnIndex: 1,
      utterance: 'We were talking about Dr. Smith.',
      focus: [{ kind: 'person', displayValue: 'Dr. Smith', resolverKey: 'Dr. Smith', referable: true, tier: 'authoritative' }],
    });
    const paulIncidental = rec({
      turnIndex: 2,
      utterance: 'Paul drove me there.',
      focus: [{ kind: 'person', displayValue: 'Paul', resolverKey: 'Paul', referable: true, tier: 'conversational' }],
    });
    const ledgerCompeting = [drSmithFirst, paulIncidental]; // Paul is the NEWER mention

    // Without a semantic selector available, the deterministic layer must
    // never silently pick the newest candidate — it must go ambiguous.
    const noInterpreterOutcome = await answerActiveSubjectReference('He wants me back next month.', { ledgerEntries: ledgerCompeting });
    assertTrue(
      'competing (no interpreter): does NOT silently resolve to the newest mention',
      noInterpreterOutcome.handled === true && noInterpreterOutcome.kind === 'ambiguous',
    );

    // With the bounded semantic selector available, Stage B — not recency —
    // decides. The mock simulates the model correctly favoring Dr. Smith
    // (medical/appointment context) over Paul (incidental "drove me there").
    let capturedPrompt = '';
    // buildRecapCandidates scans newest-first, so the candidate LIST (and
    // therefore the prompt's numbering) is [Paul(0), Dr. Smith(1)] — Paul
    // is the newer mention. selectedIndex:1 simulates the model correctly
    // favoring the OLDER, semantically-relevant Dr. Smith over the newer,
    // incidental Paul.
    const mockCtx = {
      completion: async (args: any) => {
        capturedPrompt = args.messages[1].content;
        return { text: '{"applicable":true,"selectedIndex":1,"ambiguous":false,"confidence":0.85}' };
      },
    } as any;
    const withInterpreterOutcome = await answerActiveSubjectReference('He wants me back next month.', {
      ledgerEntries: ledgerCompeting,
      getInterpreterCtx: () => mockCtx,
    });
    assertTrue('competing: Stage B was consulted with both candidates present', capturedPrompt.includes('Dr. Smith') && capturedPrompt.includes('Paul'));
    assertTrue('competing: resolves via grounding, kind correct', withInterpreterOutcome.handled === true && withInterpreterOutcome.kind === 'grounding');
    assert(
      'competing: resolved to Dr. Smith per Stage B judgment, not Paul the newer mention',
      withInterpreterOutcome.handled && withInterpreterOutcome.kind === 'grounding' ? withInterpreterOutcome.focus[0]?.resolverKey : null,
      'Dr. Smith',
    );
  }

  console.log(`\n${BOLD}-- Genuine ambiguity: existing ConversationSession pending authority, not a second mechanism --${RESET}`);
  {
    const paulRecord = rec({
      turnIndex: 3,
      utterance: 'Paul drove me there.',
      focus: [{ kind: 'person', displayValue: 'Paul', resolverKey: 'Paul', referable: true, tier: 'conversational' }],
    });
    const ledgerAmbig = [establishDrSmith, paulRecord];
    const ambigOutcome = await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: ledgerAmbig });
    assertTrue('ambiguous: handled', ambigOutcome.handled === true);
    assert('ambiguous: kind', ambigOutcome.handled ? ambigOutcome.kind : null, 'ambiguous');
    assertTrue(
      'ambiguous: reply names both candidates, no silent selection',
      ambigOutcome.handled && ambigOutcome.kind === 'ambiguous' && /Dr\. Smith/.test(ambigOutcome.reply) && /Paul/.test(ambigOutcome.reply),
    );

    if (ambigOutcome.handled && ambigOutcome.kind === 'ambiguous') {
      const session = new ConversationSession();
      session.setPending({ pendingKey: 'active_subject_clarify', resume: ambigOutcome.resume });
      assertTrue('ambiguous: existing pending state created', session.hasPending());
      assert('ambiguous: pending key is a plain clarify key, not a new architecture', session.peekPendingKey(), 'active_subject_clarify');

      const nonMatch = await session.resolvePending('purple.');
      assertTrue('ambiguous: non-matching reply falls to the existing re-ask ladder, never guesses', nonMatch.status === 'pending' || nonMatch.status === 'noop');
      if (nonMatch.status === 'pending') {
        assertTrue('ambiguous: pending remains armed after a non-match re-ask', session.hasPending());
      }

      const resolved = await session.resolvePending('Dr. Smith.');
      assertTrue('ambiguous: next candidate-selection answer resolves deterministically', resolved.status === 'committed');
      assertTrue('ambiguous: resolved ack names the selected candidate', resolved.status === 'committed' && resolved.ack.includes('Dr. Smith'));
      assertTrue('ambiguous: resolved CommitResult carries referenceOnly (never authoritative)', resolved.status === 'committed' && (resolved as any).referenceOnly === true);
      assertTrue('ambiguous: pending is cleared once resolved', !session.hasPending());
    }
  }

  console.log(`\n${BOLD}-- Ambiguity end-to-end through processUtterance: ledger records tier:'conversational', not 'authoritative' --${RESET}`);
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    ledger.push({ ...establishDrSmith, establishedAt: Date.now() });
    ledger.push({
      establishedAt: Date.now(), utterance: 'Paul drove me there.', intentType: null,
      operation: 'conversational', outcome: 'declined', authorityTier: 'conversational',
      assistantReplySummary: null,
      focus: [{ kind: 'person', displayValue: 'Paul', resolverKey: 'Paul', referable: true, tier: 'conversational' }],
    });
    const ambigOutcome = await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: ledger.peek(Date.now()) });
    if (ambigOutcome.handled && ambigOutcome.kind === 'ambiguous') {
      session.setPending({ pendingKey: 'active_subject_clarify', resume: ambigOutcome.resume });
      const outcome = await processUtterance('Dr. Smith.', session, deps, null, null, null, null, null, null, ledger);
      assertTrue('e2e ambiguity: pending resume handled by processUtterance', outcome.handled === true && outcome.source === 'pending_resume');
      const entries = ledger.peek(Date.now());
      const last = entries[entries.length - 1];
      assert('e2e ambiguity: pushed record utterance is this turn\'s own text', last?.utterance, 'Dr. Smith.');
      assertTrue('e2e ambiguity: pushed focus tier is conversational', last?.focus[0]?.tier === 'conversational');
      assertTrue('e2e ambiguity: pushed focus tier is NEVER authoritative from a mere reference resolution', last?.focus[0]?.tier !== 'authoritative');
    } else {
      assertTrue('e2e ambiguity: setup produced an ambiguous outcome to test against', false);
    }
  }

  console.log(`\n${BOLD}-- Harmless intervening turn does not destroy the usable subject relationship --${RESET}`);
  {
    const harmless = rec({ turnIndex: 2, utterance: 'The weather is nice today.', focus: [] });
    const ledgerHarmless = [establishDrSmith, harmless];
    const afterHarmless = await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: ledgerHarmless });
    assertTrue(
      'harmless turn: still resolves Dr. Smith',
      afterHarmless.handled === true && afterHarmless.kind === 'identity' && afterHarmless.reply.includes('Dr. Smith'),
    );
  }

  console.log(`\n${BOLD}-- Session/ledger loss honesty: never fabricates a remembered conversation --${RESET}`);
  {
    assertTrue('session-loss: empty ledger, identity question -> handled false', (await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: [] })).handled === false);
    assertTrue('session-loss: empty ledger, content question -> handled false', (await answerActiveSubjectReference('What was I saying about him?', { ledgerEntries: [] })).handled === false);
    assertTrue('session-loss: empty ledger, grounding statement -> handled false', (await answerActiveSubjectReference('He wants me to come back next month.', { ledgerEntries: [] })).handled === false);

    const realLedger = createConversationTurnLedger();
    realLedger.push({
      establishedAt: Date.now() - 20 * 60 * 1000, // older than the ledger's own 10-minute TTL
      utterance: 'I saw Dr. Smith today.',
      intentType: 'medical_visit',
      operation: 'capture',
      outcome: 'committed',
      authorityTier: 'deterministic',
      assistantReplySummary: null,
      focus: [{ kind: 'person', displayValue: 'Dr. Smith', resolverKey: 'Dr. Smith', referable: true, tier: 'authoritative' }],
    });
    const expiredEntries = realLedger.peek(Date.now());
    assert('session-loss: expired record actually evicted by the real ledger (not a test double)', expiredEntries.length, 0);
    const expiredOutcome = await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: expiredEntries });
    assertTrue('session-loss: expired ledger -> handled false, never fabricates', expiredOutcome.handled === false);
  }

  console.log(`\n${BOLD}-- Behavioral zero-authoritative-write proof (the acceptance journey, against a real DB) --${RESET}`);
  {
    const { db, session, deps } = freshDb();
    const ledger = createConversationTurnLedger();

    // 1) Establish Dr. Smith through the existing trustworthy medical_visit
    //    capture -> confirm path. This is the ONLY write this whole journey
    //    is expected to make.
    await processUtterance('I saw Dr. Smith today.', session, deps, null, null, null, null, null, null, ledger);
    await processUtterance('Yes.', session, deps, null, null, null, null, null, null, ledger);
    const countAfterEstablish = medicalRecordsCount(db);
    assert('behavioral: establishment performs exactly the expected write', countAfterEstablish, 1);

    // 2) Natural referential continuation. Mirrors exactly what ChatScreen's
    //    needs_clarification wiring does: resolve, then push the resulting
    //    focus (if any) onto the SAME ledger — never call any domain writer.
    const groundingOutcome = await answerActiveSubjectReference('He wants me to come back next month.', {
      ledgerEntries: ledger.peek(Date.now()),
    });
    assertTrue('behavioral: continuation turn grounds successfully', groundingOutcome.handled === true && groundingOutcome.kind === 'grounding');
    if (groundingOutcome.handled && groundingOutcome.kind === 'grounding') {
      ledger.push({
        establishedAt: Date.now(),
        utterance: 'He wants me to come back next month.',
        intentType: null,
        operation: 'conversational',
        outcome: 'declined',
        authorityTier: 'conversational',
        assistantReplySummary: null,
        focus: groundingOutcome.focus,
      });
    }
    assert('behavioral: referential continuation performs ZERO additional writes', medicalRecordsCount(db), 1);

    // 3) Later identity/content reference questions.
    await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('behavioral: identity question performs ZERO writes', medicalRecordsCount(db), 1);
    await answerActiveSubjectReference('What was I saying about him?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('behavioral: content question performs ZERO writes', medicalRecordsCount(db), 1);
    await answerActiveSubjectReference('Who did I mean there?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('behavioral: held-out reference question performs ZERO writes', medicalRecordsCount(db), 1);

    void deps;
  }

  console.log(`\n${BOLD}-- Static guardrail: the module cannot reach db writers even in principle --${RESET}`);
  {
    const src = fs.readFileSync(activeSubjectModulePath, 'utf8');
    assertTrue('static: no import from src/db/', !/from\s+['"]\.\.\/db\//.test(src));
    assertTrue(
      'static: DOMAIN_WRITERS never imported or invoked (a doc-comment mention of the name is fine)',
      !/import[^\n]*DOMAIN_WRITERS/.test(src) && !/DOMAIN_WRITERS\[/.test(src) && !/DOMAIN_WRITERS\.\w+\(/.test(src),
    );
    assertTrue('static: no reference to any write* function name', !/\bwrite[A-Z]\w*\(/.test(src));
  }

  console.log(`\n${BOLD}-- Candidate resolution: kind-compatibility filtering --${RESET}`);
  {
    const thingRecord = rec({ turnIndex: 1, utterance: 'x', focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const resolution = await resolveActiveSubjectCandidate('He wants me back next month.', [thingRecord].map((r, i) => ({
      index: i, kind: r.focus[0]!.kind, displayValue: r.focus[0]!.displayValue, record: r, focus: r.focus[0]!, intentType: r.intentType,
    })));
    assert('kind-filter: a thing-kind candidate is not person-compatible -> none', resolution.kind, 'none');
  }

  console.log(`\n${BOLD}-- Establishment path: medical_visit and doctor_intro_capture now emit person focus --${RESET}`);
  {
    const { db } = freshDb();
    const visitConfirm = await DOMAIN_WRITERS.medical_visit!.add(
      { type: 'medical_visit', doctor_name: 'Dr. Smith', raw: 'I saw Dr. Smith today.' } as any,
      'I saw Dr. Smith today.',
    );
    assertTrue('medical_visit: still returns pending confirm as before', visitConfirm.status === 'pending');
    if (visitConfirm.status === 'pending') {
      const committed = await visitConfirm.resume('Yes.');
      assertTrue('medical_visit: commits as before', committed.status === 'committed');
      assert('medical_visit: focus kind is person', (committed as any).focus?.kind, 'person');
      assert('medical_visit: focus displayValue is the doctor name', (committed as any).focus?.displayValue, 'Dr. Smith');
      assert(
        'medical_visit: resolverKey is the doctor NAME, not the medical_records row id (no opaque doctor id exists)',
        (committed as any).focus?.resolverKey,
        'Dr. Smith',
      );
    }
    void db;
  }
  {
    const { db } = freshDb();
    const introConfirm = await DOMAIN_WRITERS.doctor_intro_capture!.add(
      { type: 'doctor_intro_capture', name: 'Dr. Jones', specialty: 'cardiologist', raw: 'My doctor is Dr. Jones, a cardiologist.' } as any,
      'My doctor is Dr. Jones, a cardiologist.',
    );
    assertTrue('doctor_intro_capture: still returns pending confirm as before', introConfirm.status === 'pending');
    if (introConfirm.status === 'pending') {
      const committed = await introConfirm.resume('Yes.');
      assertTrue('doctor_intro_capture: commits as before', committed.status === 'committed');
      assert('doctor_intro_capture: focus kind is person', (committed as any).focus?.kind, 'person');
      assert('doctor_intro_capture: resolverKey is the doctor name', (committed as any).focus?.resolverKey, 'Dr. Jones');
    }
    void db;
  }

  console.log(`\n${BOLD}-- Diagnostics: HERALD_ACTIVE_SUBJECT_DIAG event shape for device acceptance --${RESET}`);
  {
    // Grounding success path.
    const { events: groundedEvents } = await captureActiveSubjectDiagEvents(() =>
      answerActiveSubjectReference('He wants me to come back next month.', { ledgerEntries: [establishDrSmith] }),
    );
    assert('diag: exactly one event per call', groundedEvents.length, 1);
    const g = groundedEvents[0];
    assertTrue('diag(grounded): invoked true', g.invoked === true);
    assert('diag(grounded): act', g.act, 'grounding');
    assert('diag(grounded): candidateCount', g.candidateCount, 1);
    assertTrue('diag(grounded): candidates carry bounded fields only (no raw resolverKey value)', g.candidates[0]?.hasResolverKey === true && !('resolverKey' in g.candidates[0]));
    assert('diag(grounded): fastPathUsed', g.fastPathUsed, true);
    assert('diag(grounded): semanticStageInvoked', g.semanticStageInvoked, false);
    assert('diag(grounded): selectedCandidateIndex', g.selectedCandidateIndex, 0);
    assert('diag(grounded): selectedCandidateKind', g.selectedCandidateKind, 'person');
    assert('diag(grounded): resultingFocusTier', g.resultingFocusTier, 'conversational');
    assert('diag(grounded): pendingArmed', g.pendingArmed, false);
    assert('diag(grounded): finalOutcome', g.finalOutcome, 'grounded');

    // Fail-closed / not_applicable path.
    const notApplicableCtx = {
      completion: async () => ({ text: '{"applicable":false,"selectedIndex":null,"ambiguous":false,"confidence":0.9}' }),
    } as any;
    const { events: naEvents } = await captureActiveSubjectDiagEvents(() =>
      answerActiveSubjectReference('What did I ask the doctor?', { ledgerEntries: [establishDrSmith], getInterpreterCtx: () => notApplicableCtx }),
    );
    const na = naEvents[0];
    assert('diag(not-applicable): act', na.act, 'not_applicable');
    assert('diag(not-applicable): semanticStageInvoked', na.semanticStageInvoked, true);
    assert('diag(not-applicable): semanticResult', na.semanticResult, 'not_applicable');
    assert('diag(not-applicable): finalOutcome', na.finalOutcome, 'not_handled');
    assert('diag(not-applicable): pendingArmed', na.pendingArmed, false);

    // Ambiguous path.
    const paulRecord = rec({ turnIndex: 2, utterance: 'Paul drove me there.', focus: [{ kind: 'person', displayValue: 'Paul', resolverKey: 'Paul', referable: true, tier: 'conversational' }] });
    const { events: ambigEvents } = await captureActiveSubjectDiagEvents(() =>
      answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: [establishDrSmith, paulRecord] }),
    );
    const amb = ambigEvents[0];
    assert('diag(ambiguous): act', amb.act, 'identity_lookup');
    assert('diag(ambiguous): candidateCount', amb.candidateCount, 2);
    assert('diag(ambiguous): finalOutcome', amb.finalOutcome, 'ambiguous');
    assert('diag(ambiguous): pendingArmed', amb.pendingArmed, true);

    // Never logs unrestricted personal memory — only bounded, already-
    // normalized fields (same discipline as HERALD_IMMEDIATE_RECAP_DIAG).
    const src = fs.readFileSync(activeSubjectModulePath, 'utf8');
    assertTrue('diag: no raw resolverKey value is ever placed on the logged event shape', !/resolverKey:\s*c\.focus\.resolverKey/.test(src.split('function toDiagCandidate')[1] ?? ''));
  }

  function publishContinuity(
    ledger: ReturnType<typeof createConversationTurnLedger>,
    text: string,
    outcome: Awaited<ReturnType<typeof processUtterance>>,
  ) {
    if (outcome.handled) return;
    const isRead = outcome.routeDecision.kind === 'device_read';
    ledger.push({
      establishedAt: Date.now(),
      utterance: text,
      intentType: null,
      operation: isRead ? 'read' : 'conversational',
      outcome: isRead ? 'presented' : 'generated',
      authorityTier: isRead ? 'deterministic' : 'conversational',
      assistantReplySummary: null,
      focus: continuityLedgerFocus(outcome.continuityFocus, outcome.continuityReferenceOnly === true),
    });
  }

  console.log(`\n${BOLD}-- Pass 1: narrative person exactly-one publication --${RESET}`);
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const discourse = new DiscourseContinuityHolder();
    const subject = new ConversationalSubjectHolder();
    const text = 'Paul called me yesterday.';
    const outcome = await processUtterance(text, session, deps, subject, null, null, null, null, discourse, ledger);
    assertTrue('narrative: unhandled (not a domain write)', outcome.handled === false);
    assert('narrative: WCS stores Paul', discourse.peekTopic()?.displayName, 'Paul');
    assertTrue('narrative: Flow C not armed', !subject.hasLive());
    assertTrue('narrative: orchestration exposes exactly-one person focus', !outcome.handled && outcome.continuityFocus?.kind === 'person' && outcome.continuityFocus.displayValue === 'Paul');
    assertTrue('narrative: referenceOnly publication', !outcome.handled && outcome.continuityReferenceOnly === true);
    publishContinuity(ledger, text, outcome);
    const published = ledger.peek(Date.now()).flatMap((e) => e.focus);
    assert('narrative: ledger focus tier is conversational', published[0]?.tier, 'conversational');
    assertTrue('narrative: no resolverKey (not a stored contact)', published[0]?.resolverKey === undefined);
    const who = await answerActiveSubjectReference('Who was I talking about?', { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('narrative: identity resolves Paul', who.handled === true && who.kind === 'identity' && who.reply.includes('Paul'));
    assertTrue('narrative: Level-1 reply is not a stored-contact claim', who.handled === true && !/number|phone|contact/i.test(who.reply));
  }
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const discourse = new DiscourseContinuityHolder();
    const text = "What's on my grocery list for Paul?";
    const outcome = await processUtterance(text, session, deps, null, null, null, null, null, discourse, ledger);
    assertTrue('domain-read: unhandled device_read (not narrative)', outcome.handled === false && outcome.routeDecision.kind === 'device_read');
    assertTrue('domain-read: does not publish narrative continuityFocus from WCS extraction', outcome.handled === false && outcome.continuityFocus === undefined);
    publishContinuity(ledger, text, outcome);
    assert('domain-read: ledger has no person focus', ledger.peek(Date.now()).flatMap((e) => e.focus).length, 0);
  }
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const discourse = new DiscourseContinuityHolder();
    const text = 'Paul and Mary called me.';
    const outcome = await processUtterance(text, session, deps, null, null, null, null, null, discourse, ledger);
    assertTrue('two-name: no exactly-one continuityFocus', outcome.handled === false && outcome.continuityFocus === undefined);
    publishContinuity(ledger, text, outcome);
    assert('two-name: no person focus published', ledger.peek(Date.now()).flatMap((e) => e.focus).length, 0);
    const who = await answerActiveSubjectReference('Who was I talking about?', { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('two-name: no false selection', who.handled === false);
  }

  console.log(`\n${BOLD}-- Pass 1: doctor visit-history read + Flow C coexistence --${RESET}`);
  {
    const { session, deps } = freshDb();
    writeMedicalRecord({ doctor_name: 'Dr Smith', visit_date: '2026-08-01', status: 'noted' });
    const ledger = createConversationTurnLedger();
    const subject = new ConversationalSubjectHolder();
    const discourse = new DiscourseContinuityHolder();
    const text = 'What was my last visit with Dr Smith?';
    const outcome = await processUtterance(text, session, deps, subject, null, null, null, null, discourse, ledger);
    assertTrue('doctor: Flow C medical subject established', subject.peek()?.domain === 'medical_doctor');
    assertTrue('doctor: Flow C displayName is the resolved doctor', !!subject.peek()?.displayName && /smith/i.test(subject.peek()!.displayName));
    assertTrue('doctor: continuity person focus present', !outcome.handled && outcome.continuityFocus?.kind === 'person' && /smith/i.test(outcome.continuityFocus.displayValue));
    assertTrue('doctor: not referenceOnly (name-as-resolverKey, deterministic read)', !outcome.handled && outcome.continuityReferenceOnly === false);
    publishContinuity(ledger, text, outcome);
    const focus = ledger.peek(Date.now()).flatMap((e) => e.focus);
    assertTrue('doctor: ledger has person focus', focus[0]?.kind === 'person' && /smith/i.test(focus[0].displayValue));
    assert('doctor: resolverKey is the doctor name, not an invented row id', focus[0]?.resolverKey, subject.peek()?.entityId);
    assert('doctor: read-resolved focus is deterministic_unconfirmed, not a fake commit', focus[0]?.tier, 'deterministic_unconfirmed');
    assertTrue('doctor: focus is not authoritative', focus[0]?.tier !== 'authoritative');
    const who = await answerActiveSubjectReference('Who was I talking about?', { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('doctor: Level-1 names Dr Smith', who.handled === true && who.kind === 'identity' && /smith/i.test(who.reply));
    const when = await processUtterance('When did I see him?', session, deps, subject, null, null, null, null, discourse, ledger);
    assertTrue('doctor: Flow C still owns when-did-I-see-him', when.handled === true && when.source === 'referent_resume');
    assertTrue('doctor: Flow C reread names the visit, not Level-1 identity-only', when.handled === true && /last saw/i.test(when.responseText) && /smith/i.test(when.responseText));
  }

  console.log(`\n${BOLD}-- Medical_doctor preservation across closed identity processUtterance --${RESET}`);
  {
    const { session, deps } = freshDb();
    writeMedicalRecord({ doctor_name: 'Dr Smith', visit_date: '2026-08-01', status: 'noted' });
    const ledger = createConversationTurnLedger();
    const subject = new ConversationalSubjectHolder();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance('What was my last visit with Dr Smith?', session, deps, subject, null, null, null, null, discourse, ledger);
    const whoTurn = await processUtterance('Who was I talking about?', session, deps, subject, null, null, null, null, discourse, ledger);
    assertTrue('identity-bridge: identity turn is not Flow C consume', whoTurn.handled === false);
    assertTrue('identity-bridge: medical_doctor remains live', subject.hasLive() && subject.peek()?.domain === 'medical_doctor');
    assertTrue('identity-bridge: preserved subject is still Smith', !!subject.peek()?.displayName && /smith/i.test(subject.peek()!.displayName));
    const when = await processUtterance('When did I last see him?', session, deps, subject, null, null, null, null, discourse, ledger);
    assertTrue('identity-bridge: when-did-I-last-see-him is referent_resume', when.handled === true && when.source === 'referent_resume');
    assertTrue('identity-bridge: fresh visit-history reread names Smith', when.handled === true && /last saw/i.test(when.responseText) && /smith/i.test(when.responseText));
    assertTrue('identity-bridge: not unresolved_referent', !(when.handled === false && when.routeDecision.kind === 'device_read' && when.routeDecision.reason === 'medical:visit_history_unresolved_referent'));
  }
  {
    const { session, deps } = freshDb();
    writeMedicalRecord({ doctor_name: 'Dr Smith', visit_date: '2026-08-01', status: 'noted' });
    const subject = new ConversationalSubjectHolder();
    await processUtterance('What was my last visit with Dr Smith?', session, deps, subject, null, null, null, null, null, null);
    const unused = await processUtterance('Open YouTube', session, deps, subject, null, null, null, null, null, null);
    assertTrue('unused-control: unrelated turn is not referent_resume', !(unused.handled === true && unused.source === 'referent_resume'));
    assertTrue('unused-control: medical_doctor cleared', !subject.hasLive());
    const later = await processUtterance('When did I last see him?', session, deps, subject, null, null, null, null, null, null);
    assertTrue('unused-control: later pronoun is unresolved_referent', later.handled === false && later.routeDecision.kind === 'device_read' && later.routeDecision.reason === 'medical:visit_history_unresolved_referent');
  }

  console.log(`\n${BOLD}-- Pass 1: medication thing consumption --${RESET}`);
  {
    const pending = rec({
      utterance: 'I take lisinopril.',
      intentType: 'medical_capture',
      operation: 'capture',
      outcome: 'pending',
      focus: [{ kind: 'thing', displayValue: 'lisinopril', referable: true, tier: 'deterministic_unconfirmed' }],
    });
    const pendingOut = await answerActiveSubjectReference('Which medication was I talking about?', { ledgerEntries: [pending] });
    assertTrue('med-pending: handled identity', pendingOut.handled === true && pendingOut.kind === 'identity');
    assertTrue('med-pending: names lisinopril', pendingOut.handled === true && /lisinopril/i.test(pendingOut.reply));
    assertTrue('med-pending: does not assert stored-truth "you take"', pendingOut.handled === true && !/\byou take\b/i.test(pendingOut.reply));
    const recapYield = await answerImmediateSemanticRecap('Which medication was I talking about?', { ledgerEntries: [pending] });
    assertTrue('med-pending: recap yields (does not reread as Level-2)', recapYield.handled === false);
  }
  {
    const committed = rec({
      utterance: 'Yes.',
      intentType: 'medical_capture',
      operation: 'capture',
      outcome: 'committed',
      focus: [{ kind: 'thing', displayValue: 'lisinopril', resolverKey: 'med_lisinopril', referable: true, tier: 'authoritative' }],
    });
    const committedOut = await answerActiveSubjectReference('Which medication was I talking about?', { ledgerEntries: [committed] });
    assertTrue('med-commit: Level-1 identity still resolves', committedOut.handled === true && committedOut.kind === 'identity' && /lisinopril/i.test(committedOut.reply));
    assertTrue('med-commit: Level-1 does not speak dosage/reread', committedOut.handled === true && !/\d+\s*mg/i.test(committedOut.reply));
  }
  {
    const a = rec({ turnIndex: 1, utterance: 'lisinopril', intentType: 'medical_capture', focus: [{ kind: 'thing', displayValue: 'lisinopril', resolverKey: 'm1', referable: true, tier: 'authoritative' }] });
    const b = rec({ turnIndex: 2, utterance: 'metformin', intentType: 'medical_capture', focus: [{ kind: 'thing', displayValue: 'metformin', resolverKey: 'm2', referable: true, tier: 'authoritative' }] });
    const amb = await answerActiveSubjectReference('Which medication was I talking about?', { ledgerEntries: [a, b] });
    assertTrue('med-two: clarifies, no silent newest pick', amb.handled === true && amb.kind === 'ambiguous');
    assertTrue('med-two: names both', amb.handled === true && amb.kind === 'ambiguous' && /lisinopril/i.test(amb.reply) && /metformin/i.test(amb.reply));
  }
  {
    const miss = await answerActiveSubjectReference('Which medication was I talking about?', { ledgerEntries: [] });
    assertTrue('med-zero: honest miss (handled, no fabricated name)', miss.handled === true && miss.kind === 'identity' && !/lisinopril|metformin/i.test(miss.reply));
  }
  {
    const groceryThing = rec({
      turnIndex: 1,
      utterance: 'bananas',
      intentType: 'list_add',
      operation: 'capture',
      focus: [{ kind: 'thing', displayValue: 'bananas', resolverKey: 'item_1', referable: true, tier: 'authoritative' }],
    });
    const miss = await answerActiveSubjectReference('Which medication was I talking about?', { ledgerEntries: [groceryThing] });
    assertTrue('med-provenance: non-medical thing is not eligible', miss.handled === true && miss.kind === 'identity' && !/bananas/i.test(miss.reply));
  }
  {
    const groceryThing = rec({
      turnIndex: 1,
      utterance: 'bananas',
      intentType: 'list_add',
      focus: [{ kind: 'thing', displayValue: 'bananas', resolverKey: 'item_1', referable: true, tier: 'authoritative' }],
    });
    const med = rec({
      turnIndex: 2,
      utterance: 'lisinopril',
      intentType: 'medical_capture',
      focus: [{ kind: 'thing', displayValue: 'lisinopril', resolverKey: 'm1', referable: true, tier: 'authoritative' }],
    });
    const out = await answerActiveSubjectReference('Which medication was I talking about?', { ledgerEntries: [groceryThing, med] });
    assertTrue('med-provenance: medical_capture thing remains eligible beside a non-medical thing', out.handled === true && out.kind === 'identity' && /lisinopril/i.test(out.reply));
    assertTrue('med-provenance: does not name the non-medical thing', out.handled === true && !/bananas/i.test(out.reply));
  }

  console.log(`\n${BOLD}-- Pass 1: routing ownership + authority fence --${RESET}`);
  {
    assertTrue('routing: recap Stage A does not steal "What did I say about him?"', !classifyImmediateRecapDeterministic('What did I say about him?'));
    assertTrue('routing: recap Stage A still matches generic "What did I just say?"', classifyImmediateRecapDeterministic('What did I just say?'));
    const himLedger = [establishDrSmith];
    const recapHim = await answerImmediateSemanticRecap('What did I say about him?', { ledgerEntries: himLedger });
    assertTrue('routing: recap declines about-him (Active Subject owns)', recapHim.handled === false);
    const asHim = await answerActiveSubjectReference('What did I say about him?', { ledgerEntries: himLedger });
    assertTrue('routing: Active Subject owns about-him', asHim.handled === true && asHim.kind === 'content');
  }
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const discourse = new DiscourseContinuityHolder();
    const establish = await processUtterance('Paul called me yesterday.', session, deps, null, null, null, null, null, discourse, ledger);
    publishContinuity(ledger, 'Paul called me yesterday.', establish);
    const focus = ledger.peek(Date.now()).flatMap((e) => e.focus)[0];
    assert('authority: narrative focus is conversational', focus?.tier, 'conversational');
    const textPaul = await processUtterance('Text Paul', session, deps, null, null, null, null, null, discourse, ledger);
    assertTrue('authority: Text Paul is not authorized by narrative ledger focus', !(textPaul.handled && textPaul.source === 'capture' && textPaul.commits.some((c) => c.status === 'committed')));
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ActiveSubjectReference: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('activeSubjectReference.test.ts')) {
  runActiveSubjectReferenceTests().catch(console.error);
}
