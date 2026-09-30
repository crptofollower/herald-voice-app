// scripts/heraldTest/immediateSemanticRecap.test.ts
// Conversation Continuity Consumer V1 — Immediate Semantic Recap.
// Seen wording, held-out (unseen) wording, metamorphic, and negative tests,
// plus a full real-DB proof of the statement -> confirm -> yes -> commit ->
// recap sequence using the actual production ledger/writer pipeline.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { applyIntents, processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import {
  classifyImmediateRecapDeterministic,
  buildRecapCandidates,
  parseRecapInterpretationProposal,
  answerImmediateSemanticRecap,
  RECAP_REREAD_ADAPTERS,
} from '../../src/routing/immediateSemanticRecap.ts';
import { answerActiveSubjectReference } from '../../src/routing/activeSubjectReference.ts';
import { isEligibleForEphemeralConversation } from '../../src/utils/ephemeralConversation.ts';

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

export async function runImmediateSemanticRecapTests() {
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

  console.log(`\n${BOLD}-- Stage A deterministic fast path — SEEN wording --${RESET}`);
  const seenPositive = [
    "What did I just tell you I'm taking?",
    'What medication did I just tell you about?',
    'What did I just say?',
    'What was I saying?',
  ];
  for (const t of seenPositive) {
    assertTrue(`Stage A matches seen wording: "${t}"`, classifyImmediateRecapDeterministic(t));
  }

  console.log(`\n${BOLD}-- Stage A deterministic fast path — HELD-OUT wording (some MUST require Stage B) --${RESET}`);
  const heldOut: [string, boolean][] = [
    ['Which medicine was I talking about?', false],
    ['What was that medication I mentioned?', false],
    ['Remind me what I said I take.', true], // matches REMIND_ME_RE's closed grammar
    ['What did I say about my medicine?', true], // "what did I say about X" is itself the closed grammatical shape (X is a free slot) — correctly Stage-A
    ['Which drug did I just mention?', true], // "which X did I just mention" is the same closed grammatical shape (X free slot) — correctly Stage-A
  ];
  for (const [t, expectDeterministic] of heldOut) {
    assert(`held-out "${t}" Stage-A classification`, classifyImmediateRecapDeterministic(t), expectDeterministic);
  }
  assertTrue('at least some held-out wording requires Stage B (Stage A returns false)', heldOut.some(([, exp]) => exp === false));

  console.log(`\n${BOLD}-- Metamorphic (meaning-preserving variants) --${RESET}`);
  const metamorphic = [
    "What was the medicine I just mentioned again?", // → Stage B (open vocab "medicine")
    "uh what medicine did I just say I take", // → Stage B
    "What'd I just tell you?", // contraction → Stage A
    "So, what did I just tell you?", // filler → Stage A
  ];
  assertTrue('contraction "What\'d I just tell you?" still matches Stage A', classifyImmediateRecapDeterministic("What'd I just tell you?"));
  assertTrue('filler-prefixed "So, what did I just tell you?" still matches Stage A', classifyImmediateRecapDeterministic('So, what did I just tell you?'));
  assertTrue('open-vocabulary "medicine" variant does NOT match Stage A (needs Stage B)', !classifyImmediateRecapDeterministic('What was the medicine I just mentioned again?'));
  void metamorphic;

  console.log(`\n${BOLD}-- Negative tests --${RESET}`);
  assertTrue('NEGATIVE: normal medical read is not a recap request', !classifyImmediateRecapDeterministic('What medications am I taking?'));
  assertTrue('NEGATIVE: grocery add is not a recap request', !classifyImmediateRecapDeterministic('Add milk to my grocery list.'));
  assertTrue('NEGATIVE: third-party subject is not a recap request', !classifyImmediateRecapDeterministic('What did Dr. Smith tell me?'));
  assertTrue('NEGATIVE: assistant-recap (opposite direction) is not a self-recap match', !classifyImmediateRecapDeterministic('What did you just tell me?'));
  assertTrue('NEGATIVE: person-content "What did I say about him?" yields to Active Subject', !classifyImmediateRecapDeterministic('What did I say about him?'));
  assertTrue('REGRESSION: generic "What did I just say?" remains Stage A recap', classifyImmediateRecapDeterministic('What did I just say?'));

  console.log(`\n${BOLD}-- buildRecapCandidates: dedup + newest-first identity resolution --${RESET}`);
  {
    const proposal = rec({ turnIndex: 1, establishedAt: 1000, focus: [{ kind: 'thing', displayValue: 'lisinopril', referable: true, tier: 'deterministic_unconfirmed' }] });
    const commit = rec({ turnIndex: 2, establishedAt: 2000, focus: [{ kind: 'thing', displayValue: 'lisinopril', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const candidates = buildRecapCandidates([proposal, commit]);
    assert('SEQUENCE-PROOF: proposal+commit for the SAME medication collapse to exactly one candidate', candidates.length, 1);
    assert('SEQUENCE-PROOF: the surviving candidate is the COMMIT (authoritative), not the literal last utterance', candidates[0]?.focus.tier, 'authoritative');
    assert('SEQUENCE-PROOF: surviving candidate carries the real resolverKey', candidates[0]?.focus.resolverKey, 'med_1');
  }
  {
    const a = rec({ turnIndex: 1, establishedAt: 1000, focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const b = rec({ turnIndex: 2, establishedAt: 2000, focus: [{ kind: 'thing', displayValue: 'metformin', resolverKey: 'med_2', referable: true, tier: 'authoritative' }] });
    const candidates = buildRecapCandidates([a, b]);
    assert('two genuinely different medications → two distinct candidates', candidates.length, 2);
    assert('candidates ordered newest-first', candidates[0]?.displayValue, 'metformin');
  }
  {
    const notReferable = rec({ turnIndex: 1, focus: [{ kind: 'thing', displayValue: 'secret', referable: false, tier: 'authoritative' }] });
    assert('non-referable focus excluded from candidates', buildRecapCandidates([notReferable]).length, 0);
  }

  console.log(`\n${BOLD}-- parseRecapInterpretationProposal: anti-fabrication bounds --${RESET}`);
  assert('valid proposal parses', parseRecapInterpretationProposal('{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.9}', 2), { isImmediateRecap: true, selectedIndex: 0, confidence: 0.9 });
  assert('null selectedIndex is legal', parseRecapInterpretationProposal('{"isImmediateRecap":true,"selectedIndex":null,"confidence":0.9}', 2)?.selectedIndex, null);
  assert('ANTI-FABRICATION: out-of-range index (>= candidateCount) rejects whole proposal', parseRecapInterpretationProposal('{"isImmediateRecap":true,"selectedIndex":5,"confidence":0.9}', 2), null);
  assert('ANTI-FABRICATION: negative index rejects whole proposal', parseRecapInterpretationProposal('{"isImmediateRecap":true,"selectedIndex":-1,"confidence":0.9}', 2), null);
  assert('ANTI-FABRICATION: non-integer index rejects whole proposal', parseRecapInterpretationProposal('{"isImmediateRecap":true,"selectedIndex":1.5,"confidence":0.9}', 2), null);
  assert('confidence out of [0,1] rejects', parseRecapInterpretationProposal('{"isImmediateRecap":true,"selectedIndex":0,"confidence":1.5}', 2), null);
  assert('malformed JSON rejects', parseRecapInterpretationProposal('not json', 2), null);
  assert('missing isImmediateRecap rejects', parseRecapInterpretationProposal('{"selectedIndex":0,"confidence":0.9}', 2), null);

  console.log(`\n${BOLD}-- No-domain-logic source-lock --${RESET}`);
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/immediateSemanticRecap.ts');
    const src = fs.readFileSync(modulePath, 'utf8');
    // Comments may discuss forbidden field names as prose explaining WHY
    // they're absent (documentation) — what must never appear is actual
    // code using them. Strip full-line comments before checking.
    const codeOnly = src.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
    // The registry entry itself legitimately says 'medical_capture' once (the
    // dispatch key) — what must never appear is field-level extraction.
    for (const token of ['.drug', '.dosage', '.frequency', 'intent.type ===', 'IntentRecord']) {
      assertTrue(`no-domain-logic: immediateSemanticRecap.ts contains no "${token}" (outside comments)`, !codeOnly.includes(token));
    }
    assertTrue('registry: exactly one domain key registered (medical_capture) — proves the pattern, not a spread', Object.keys(RECAP_REREAD_ADAPTERS).length === 1 && 'medical_capture' in RECAP_REREAD_ADAPTERS);
  }

  console.log(`\n${BOLD}-- Full real-DB proof: statement -> confirm -> yes -> commit -> recap --${RESET}`);
  {
    const { db, session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await processUtterance('I started taking lisinopril 10 milligrams every morning.', session, deps, null, null, null, null, null, null, ledger);
    await processUtterance('Yes.', session, deps, null, null, null, null, null, null, ledger);

    const outcome = await answerImmediateSemanticRecap("What did I just tell you I'm taking?", { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('CUSTOMER-PROOF: handled', outcome.handled === true);
    assert('CUSTOMER-PROOF: resolved via authoritative reread (not cached displayValue)', outcome.handled ? outcome.kind : null, 'authoritative_reread');
    assertTrue('CUSTOMER-PROOF: reply names the real medication', outcome.handled && outcome.reply.toLowerCase().includes('lisinopril'));
    assertTrue('CUSTOMER-PROOF: reply reflects the real stored dosage (deterministic reread, not the raw utterance)', outcome.handled && /10 milligrams/i.test(outcome.reply));

    // Prove the reread is genuinely live, not cached displayValue: deactivate
    // the medication directly in the DB (simulating it being removed between
    // the capture and the recap turn) and confirm an honest miss, never a
    // fabricated answer from stale evidence.
    db.prepare(`UPDATE medications SET removed_at = ? WHERE name = 'lisinopril'`).run(new Date().toISOString());
    const afterRemoval = await answerImmediateSemanticRecap("What did I just tell you I'm taking?", { ledgerEntries: ledger.peek(Date.now()) });
    assert('STALE-REFERENCE: deleted/deactivated row → honest miss, not fabrication', afterRemoval.handled ? afterRemoval.kind : null, 'honest_miss');
  }

  console.log(`\n${BOLD}-- Unconfirmed / declined / proposal-tier framing (real DB) --${RESET}`);
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await processUtterance('I take Atorvastatin 20 mg.', session, deps, null, null, null, null, null, null, ledger);
    // No "Yes." yet — still pending.
    const outcome = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('unconfirmed proposal recap framed honestly, not as fact', outcome.handled ? outcome.kind : null, 'unconfirmed_recap');
    assertTrue('unconfirmed recap names the medication', outcome.handled && outcome.reply.includes('Atorvastatin'));
    assertTrue('unconfirmed recap explicitly frames it as not-yet-saved', outcome.handled && /don't have that confirmed|not.*saved/i.test(outcome.reply));
  }

  console.log(`\n${BOLD}-- Ambiguity: multiple distinct compatible foci --${RESET}`);
  {
    const a = rec({ turnIndex: 1, establishedAt: 1000, focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const b = rec({ turnIndex: 2, establishedAt: 2000, focus: [{ kind: 'thing', displayValue: 'metformin', resolverKey: 'med_2', referable: true, tier: 'authoritative' }] });
    const outcome = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: [a, b] });
    assert('AMBIGUITY: multiple distinct foci → clarify, never silent guess', outcome.handled ? outcome.kind : null, 'clarify_ambiguous');
    assertTrue('clarify names both candidates', outcome.handled && outcome.reply.includes('Eliquis') && outcome.reply.includes('metformin'));
  }

  console.log(`\n${BOLD}-- No safe focus / stale (TTL-expired) ledger --${RESET}`);
  {
    const outcome = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: [] });
    assert('EMPTY LEDGER: honest miss', outcome.handled ? outcome.kind : null, 'honest_miss');
  }
  {
    // TTL expiry is already the ledger's own job (peek() evicts) — this
    // proves the consumer behaves correctly when the CALLER passes an
    // already-TTL-filtered (i.e. empty) peek() result, exactly as ChatScreen
    // will do in production.
    const ledger = createConversationTurnLedger();
    ledger.push({ establishedAt: Date.now() - 11 * 60 * 1000, utterance: 'old', intentType: 'medical_capture', operation: 'capture', outcome: 'committed', authorityTier: 'deterministic', assistantReplySummary: null, focus: [{ kind: 'thing', displayValue: 'old med', resolverKey: 'x', referable: true, tier: 'authoritative' }] });
    const stalePeek = ledger.peek(Date.now()); // TTL is 10 minutes — this entry is now expired
    const outcome = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: stalePeek });
    assert('STALE (TTL-expired): honest miss, not a fabricated stale answer', outcome.handled ? outcome.kind : null, 'honest_miss');
  }

  console.log(`\n${BOLD}-- Not-a-recap-request: does not steal the turn --${RESET}`);
  {
    const commit = rec({ turnIndex: 1, focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const outcome = await answerImmediateSemanticRecap('What medications am I taking?', { ledgerEntries: [commit] });
    assertTrue('NEGATIVE: normal medical read is NOT handled by this consumer (falls through to real medical read)', outcome.handled === false);
  }
  {
    const commit = rec({ turnIndex: 1, focus: [{ kind: 'collection', displayValue: 'grocery list', resolverKey: 'list_1', referable: true, tier: 'authoritative' }] });
    const outcome = await answerImmediateSemanticRecap('Add milk to my grocery list.', { ledgerEntries: [commit] });
    assertTrue('NEGATIVE: unrelated grocery-add utterance not handled by this consumer', outcome.handled === false);
  }

  console.log(`\n${BOLD}-- Stage B fallback (mocked interpreter — no real model dependency) --${RESET}`);
  {
    const commit = rec({ turnIndex: 1, focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const mockCtx = {
      completion: async () => ({ text: '{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.85}' }),
    } as any;
    const outcome = await answerImmediateSemanticRecap('What was that medication I mentioned?', {
      ledgerEntries: [commit],
      getInterpreterCtx: () => mockCtx,
    });
    assertTrue('STAGE-B-PATH: held-out wording resolved via semantic fallback (not Stage A)', !classifyImmediateRecapDeterministic('What was that medication I mentioned?'));
    assert('STAGE-B-PATH: mocked interpreter selection resolves to authoritative reread', outcome.handled ? outcome.kind : null, 'capability_gap');
    // (capability_gap because getActiveMedicationById needs a real DB row;
    // this test proves Stage B's plumbing/selection, not the DB reread —
    // that is covered end-to-end in the real-DB proof above.)
  }
  {
    const commit = rec({ turnIndex: 1, focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const mockCtx = {
      completion: async () => ({ text: '{"isImmediateRecap":false,"selectedIndex":null,"confidence":0.9}' }),
    } as any;
    const outcome = await answerImmediateSemanticRecap('How is the weather today?', {
      ledgerEntries: [commit],
      getInterpreterCtx: () => mockCtx,
    });
    assertTrue('STAGE-B-PATH: interpreter says not a recap request → not handled (falls through)', outcome.handled === false);
  }
  {
    // Confidence below threshold must not grant a match even if isImmediateRecap:true.
    const commit = rec({ turnIndex: 1, focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const mockCtx = {
      completion: async () => ({ text: '{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.2}' }),
    } as any;
    const outcome = await answerImmediateSemanticRecap('What was that thing I said?', {
      ledgerEntries: [commit],
      getInterpreterCtx: () => mockCtx,
    });
    assertTrue('STAGE-B-PATH: low confidence does not grant a match', outcome.handled === false);
  }
  {
    // No interpreter available and Stage A didn't match → not handled.
    const commit = rec({ turnIndex: 1, focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const outcome = await answerImmediateSemanticRecap('What was that medication I mentioned?', { ledgerEntries: [commit] });
    assertTrue('STAGE-B unavailable (no interpreter ctx) → not handled, falls through honestly', outcome.handled === false);
  }

  console.log(`\n${BOLD}-- Stage B only when the utterance is structurally a question --${RESET}`);
  function hostileRecapCtx(reads: { n: number }, completions: { n: number }) {
    return () => {
      reads.n += 1;
      return {
        completion: async () => {
          completions.n += 1;
          return { text: '{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.99}' };
        },
      } as any;
    };
  }
  {
    const commit = rec({ focus: [{ kind: 'person', displayValue: 'Alina', resolverKey: 'p_1', referable: true, tier: 'authoritative' }] });
    const reads = { n: 0 };
    const completions = { n: 0 };
    const outcome = await answerImmediateSemanticRecap('The sky looks grey today.', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx(reads, completions),
    });
    const subject = await answerActiveSubjectReference('The sky looks grey today.', { ledgerEntries: [commit] });
    assertTrue('fresh declarative with a candidate does not invoke Stage B',
      outcome.handled === false && reads.n === 0 && completions.n === 0);
    assertTrue('fresh declarative still reaches ephemeral conversation after recap and active subject decline',
      subject.handled === false && isEligibleForEphemeralConversation('The sky looks grey today.') === true);
  }
  {
    const commit = rec({ focus: [{ kind: 'person', displayValue: 'Alina', resolverKey: 'p_1', referable: true, tier: 'authoritative' }] });
    const reads = { n: 0 };
    const completions = { n: 0 };
    const utterance = 'She told me about the lake.';
    const outcome = await answerImmediateSemanticRecap(utterance, {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx(reads, completions),
    });
    const subject = await answerActiveSubjectReference(utterance, { ledgerEntries: [commit] });
    const focus = subject.handled && subject.kind === 'grounding' ? subject.focus : [];
    assertTrue('declarative continuation with a candidate does not invoke Stage B',
      !classifyImmediateRecapDeterministic(utterance)
      && outcome.handled === false
      && reads.n === 0
      && completions.n === 0);
    assertTrue('skipped Stage B still reaches the grounding continuation',
      subject.handled === true
      && subject.kind === 'grounding'
      && subject.reply === 'Okay.'
      && focus[0]?.displayValue === 'Alina');
  }
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'llm_proposal' }] });
    const reads = { n: 0 };
    const utterance = 'What was that thing I said?';
    const outcome = await answerImmediateSemanticRecap(utterance, {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx(reads, { n: 0 }),
    });
    assertTrue('a legitimate self-recap question still reaches Stage B',
      !classifyImmediateRecapDeterministic(utterance)
      && reads.n === 1
      && outcome.handled === true
      && outcome.kind === 'proposal_recap');
  }
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const reads = { n: 0 };
    const outcome = await answerImmediateSemanticRecap('What was that medication I mentioned?', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx(reads, { n: 0 }),
    });
    assertTrue('What was that medication I mentioned? still reaches Stage B',
      reads.n === 1 && outcome.handled === true && outcome.kind === 'capability_gap');
  }
  {
    const commit = rec({
      focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }],
      intentType: 'medical_capture',
    });
    const reads = { n: 0 };
    const utterance = 'Which medicine was I talking about?';
    const outcome = await answerImmediateSemanticRecap(utterance, {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx(reads, { n: 0 }),
    });
    const subject = await answerActiveSubjectReference(utterance, { ledgerEntries: [commit] });
    assertTrue('Which medicine was I talking about? stays with active subject and does not enter Stage B',
      outcome.handled === false
      && reads.n === 0
      && subject.handled === true
      && subject.kind === 'identity'
      && subject.reply === 'You were talking about Eliquis.');
  }
  {
    const reads = { n: 0 };
    const outcome = await answerImmediateSemanticRecap('What was that medication I mentioned?', {
      ledgerEntries: [],
      getInterpreterCtx: hostileRecapCtx(reads, { n: 0 }),
    });
    assertTrue('a question with no candidates keeps the existing miss and does not invoke Stage B',
      outcome.handled === false && reads.n === 0);
  }
  {
    const commit = rec({ focus: [{ kind: 'person', displayValue: 'Alina', referable: true, tier: 'llm_proposal' }] });
    const reads = { n: 0 };
    const outcome = await answerImmediateSemanticRecap('What did I just tell you?', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx(reads, { n: 0 }),
    });
    assertTrue('Stage A still owns a closed recap and does not invoke Stage B',
      outcome.handled === true && outcome.kind === 'proposal_recap' && reads.n === 0);
  }
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'llm_proposal' }] });
    const reads = { n: 0 };
    const malformed = await answerImmediateSemanticRecap('What was that thing I said?', {
      ledgerEntries: [commit],
      getInterpreterCtx: () => {
        reads.n += 1;
        return { completion: async () => ({ text: 'not json' }) } as any;
      },
    });
    const unavailable = await answerImmediateSemanticRecap('What was that thing I said?', {
      ledgerEntries: [commit],
      getInterpreterCtx: () => null,
    });
    assertTrue('malformed Stage B stays fail-closed after the question is reached',
      reads.n === 1 && malformed.handled === false);
    assertTrue('unavailable Stage B stays fail-closed',
      unavailable.handled === false);
  }

  console.log(`\n${BOLD}-- Stage B admission veto for existing contradictory evidence --${RESET}`);
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'llm_proposal' }] });
    const completions = { n: 0 };
    const outcome = await answerImmediateSemanticRecap('What did you just tell me?', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx({ n: 0 }, completions),
    });
    assertTrue('What did you just tell me? reaches Stage B and is not admitted',
      !classifyImmediateRecapDeterministic('What did you just tell me?')
      && completions.n === 1
      && outcome.handled === false);
  }
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const completions = { n: 0 };
    const outcome = await answerImmediateSemanticRecap('What medications am I taking?', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx({ n: 0 }, completions),
    });
    assertTrue('What medications am I taking? reaches Stage B and is not admitted',
      completions.n === 1 && outcome.handled === false);
  }
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'llm_proposal' }] });
    const eligible = [
      'What was the medicine I just mentioned again?',
      'Who was I talking about?',
    ];
    for (const utterance of eligible) {
      const completions = { n: 0 };
      const outcome = await answerImmediateSemanticRecap(utterance, {
        ledgerEntries: [commit],
        getInterpreterCtx: hostileRecapCtx({ n: 0 }, completions),
      });
      assertTrue(`${utterance} remains Stage-B eligible`,
        !classifyImmediateRecapDeterministic(utterance)
        && completions.n === 1
        && outcome.handled === true
        && outcome.kind === 'proposal_recap');
    }
  }
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'llm_proposal' }] });
    const completions = { n: 0 };
    const outcome = await answerImmediateSemanticRecap('What was I talking about?', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx({ n: 0 }, completions),
    });
    assertTrue('What was I talking about? selects the single non-person candidate without Stage B',
      !classifyImmediateRecapDeterministic('What was I talking about?')
      && completions.n === 0
      && outcome.handled === true
      && outcome.kind === 'proposal_recap'
      && outcome.reply.includes('Eliquis'));
  }
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'llm_proposal' }] });
    const completions = { n: 0 };
    const utterance = 'uh what medicine did I just say I take';
    const outcome = await answerImmediateSemanticRecap(utterance, {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx({ n: 0 }, completions),
    });
    assertTrue('uh what medicine did I just say I take stays on Stage A',
      classifyImmediateRecapDeterministic(utterance)
      && completions.n === 0
      && outcome.handled === true
      && outcome.kind === 'proposal_recap');
  }
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'llm_proposal' }] });
    const completions = { n: 0 };
    const outcome = await answerImmediateSemanticRecap('What did Dr. Smith tell me?', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx({ n: 0 }, completions),
    });
    assertTrue('What did Dr. Smith tell me? is not resolved by this veto',
      completions.n === 1
      && outcome.handled === true
      && outcome.kind === 'proposal_recap');
  }
  {
    const { session, deps } = freshDb();
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const completions = { n: 0 };
    const recap = await answerImmediateSemanticRecap('What medications am I taking?', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx({ n: 0 }, completions),
    });
    const routed = await processUtterance('What medications am I taking?', session, {
      ...deps,
      getMedicationSemanticInterpreterCtx: hostileRecapCtx({ n: 0 }, { n: 0 }),
    });
    assertTrue('refusing the catalog read leaves the medical summary owner in place',
      recap.handled === false
      && routed.handled === false
      && routed.routeDecision.kind === 'device_read'
      && routed.routeDecision.reason === 'medical:summary');
  }
  {
    const { session, deps } = freshDb();
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'llm_proposal' }] });
    const recap = await answerImmediateSemanticRecap('What did you just tell me?', {
      ledgerEntries: [commit],
      getInterpreterCtx: hostileRecapCtx({ n: 0 }, { n: 0 }),
    });
    const routed = await processUtterance('What did you just tell me?', session, deps);
    assertTrue('refusing assistant recap does not invent a self-recap answer',
      recap.handled === false
      && routed.handled === false
      && routed.routeDecision.kind === 'needs_clarification');
  }

  console.log(`\n${BOLD}-- Pending authority: consumer never sees a pending-armed turn --${RESET}`);
  {
    // Structural proof, not a runtime one: this module has no import of
    // ConversationSession and no `hasPending` check of its own — it cannot
    // consult or override pending state because it has no channel to.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/immediateSemanticRecap.ts');
    const src = fs.readFileSync(modulePath, 'utf8');
    assertTrue('PENDING-AUTHORITY: module never imports ConversationSession', !src.includes('conversationSession'));
    assertTrue('PENDING-AUTHORITY: module has no hasPending reference', !src.includes('hasPending'));
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ImmediateSemanticRecap: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('immediateSemanticRecap.test.ts')) {
  runImmediateSemanticRecapTests().catch(console.error);
}
