// scripts/heraldTest/pipeline.test.ts
// P-tests (S54 addendum Q4): the full capture→route→confirm→commit→read chain
// through the REAL processUtterance + ConversationSession against better-sqlite3.
// Multi-turn scripts; assertions on BOTH response text and SQL rows.
// These PIN CURRENT BEHAVIOR — including known Hazard E defects, marked DEFECT
// below. S-CONFIRM flips the DEFECT pins deliberately, RED-first. Do not "fix"
// anything here.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { applyIntents, processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { writeMedicalRecord, attachVisitOutcome, getAmbiguousDoctorCandidates } from '../../src/db/medicalDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, fact TEXT NOT NULL, category TEXT,
    confidence TEXT, source_date TEXT, use_count INTEGER DEFAULT 0,
    last_used TEXT, context_type TEXT, valid_until TEXT, importance_score INTEGER
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY,
    visit_date TEXT,
    doctor_name TEXT,
    facility TEXT,
    reason TEXT,
    diagnosis TEXT,
    follow_up TEXT,
    notes TEXT,
    status TEXT DEFAULT 'noted',
    surfaced_at TEXT,
    visit_outcome TEXT,
    outcome_asked_at TEXT,
    removed_at TEXT,
    created_at TEXT
  );
`;

function makeShim(db) {
  // Reads are TOLERANT: classification touches tables this harness doesn't
  // create (calendar/profile/facts) — degrade to empty, same as run.mjs's
  // top-level shim. Writes are STRICT: a failed write must throw, never be
  // silently swallowed (Data Loss Priority #1).
  return {
    getAllSync: (s, p = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s, p = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s, p = []) => db.prepare(s).run(...p),
    execSync: (s) => db.exec(s),
  };
}

function freshPipeline() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),   // Session W swaps this stub for the live classifier
    llmReady: false,
    captureContext: { contacts: [], lists: [] },
  };
  const say = (text) => processUtterance(text, session, deps);
  const rows = () => db.prepare(`SELECT name, relationship FROM contacts WHERE removed_at IS NULL`).all();
  return { db, session, say, rows };
}

export async function runPipelineTests() {
  const failures = [];
  let passed = 0;
  function assert(label, got, check, expected) {
    if (check(got)) {
      console.log(`${GREEN}? PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}? FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Pipeline P-Tests (processUtterance, multi-turn) -------${RESET}\n`);

  // ── P1: the BUG B/C script, end to end (would have caught S53's BUG C) ──
  {
    const { say, rows } = freshPipeline();
    const t1 = await say('my wife is Shannon');
    assert('P1a wife capture asks confirm naming Shannon', t1, (v) => v.handled === true && v.responseText.includes('Shannon') && v.responseText.includes('wife'), 'handled, prompt names Shannon/wife');
    assert('P1b nothing written before confirm (ACK-matches-commit)', rows().length, (v) => v === 0, '0 rows');
    const t2 = await say('yes');
    assert('P1c yes commits with verified ack', t2, (v) => v.handled === true && v.responseText.includes('Shannon'), 'committed ack names Shannon');
    assert('P1d one contact row after commit', rows(), (v) => v.length === 1 && v[0].relationship === 'wife', '1 row, wife');
    const t3 = await say('my daughter is Shannon');
    assert('P1e daughter capture asks confirm', t3, (v) => v.handled === true && v.responseText.includes('daughter'), 'prompt names daughter');
    await say('yes');
    assert('P1f two rows — wife survived same-name daughter (BUG B)', rows().length, (v) => v === 2, '2 rows');
    const t4 = await say('tell me about my family');
    assert('P1g family read is a device_read', t4, (v) => v.handled === false && v.routeDecision.kind === 'device_read', 'device_read');
    assert('P1h overview shows both relationships (BUG C)', t4.handled === false && t4.routeDecision.kind === 'device_read' ? t4.routeDecision.response : '', (v) => v.includes('wife') && v.includes('daughter'), 'includes wife and daughter');
    assert('P1i overview lists Shannon twice (two people)', t4.handled === false && t4.routeDecision.kind === 'device_read' ? (t4.routeDecision.response.match(/Shannon/g) || []).length : 0, (v) => v === 2, 'count 2');
  }

  // ── P2: the BUG D script (have-form; would have caught S53's BUG D) ──
  {
    const { say, rows } = freshPipeline();
    const t1 = await say('I have a son named Hunter');
    assert('P2a have-form capture asks confirm naming Hunter', t1, (v) => v.handled === true && v.responseText.includes('Hunter'), 'prompt names Hunter');
    await say('yes');
    assert('P2b Hunter/son row written', rows(), (v) => v.some((r) => r.name === 'Hunter' && r.relationship === 'son'), 'Hunter/son present');
    const t2 = await say('I have another son named Grant');
    assert('P2c second confirm names GRANT, never Hunter (S53 device symptom)', t2, (v) => v.handled === true && v.responseText.includes('Grant') && !v.responseText.includes('Hunter'), 'prompt names Grant only');
    await say('yes');
    assert('P2d Grant/son row written', rows(), (v) => v.some((r) => r.name === 'Grant' && r.relationship === 'son'), 'Grant/son present');
    const t3 = await say('I have a son named Bob and another son named Tom');
    assert('P2e have-form compound defers, no half-capture (C19 at pipeline level)', t3.handled, (v) => v === false, 'handled false');
    assert('P2f compound wrote nothing', rows(), (v) => v.length === 2 && !v.some((r) => r.name === 'Bob' || r.name === 'Tom'), 'still 2 rows, no Bob/Tom');
  }

  // ── P3: Law 2 pins (S-DISCLOSE confirm-primitive, S60 build arc) ──
  {
    const { say, rows, session } = freshPipeline();
    const t1 = await say('my wife is Shannon');
    assert('P3a pending confirm live', t1, (v) => v.handled === true && v.responseText.includes('wife'), 'confirm prompt');
    const t2 = await say('ok my daughter is Shannon');
    assert('P3b Law 2: unresolvable reply re-asks — does NOT re-route as a fresh capture', t2, (v) => v.handled === true && v.source === 'pending_resume', 'pending_resume, not fresh capture');
    assert('P3b2 wife-pending stays pending — never leaks', session.hasPending(), (v) => v === true, 'true');
    assert('P3c nothing committed yet', rows().length, (v) => v === 0, '0 rows');
    const t3 = await say('yes');
    assert('P3d original wife pending still resolves on a real yes', t3, (v) => v.handled === true && v.responseText.includes('Shannon'), 'commits Shannon');
    assert('P3e one contact row after commit', rows(), (v) => v.length === 1 && v[0].relationship === 'wife', '1 row, wife');
  }
  {
    const { say, rows } = freshPipeline();
    await say('my wife is Shannon');
    const t1 = await say('no');
    assert('P3d NO branch asks for the correct name', t1, (v) => v.handled === true && v.responseText.toLowerCase().includes('correct name'), 'asks correct name');
    await say('Karen');
    assert('P3e E3 FIXED: bare-name correction commits Karen under the original relation', rows(), (v) => v.length === 1 && v[0].name === 'Karen' && v[0].relationship === 'wife', '1 row, Karen/wife');
  }

  // ── P4: LLM confirm gate (Build C) — RED pins; feature not implemented yet ──
  // Domain resume detects yes/no (CONFIRM_YES_RE); resolvePending only invokes resume.
  {
    const { session, rows } = freshPipeline();
    let addCalls = 0;
    let lastAddIntent = null;
    const originalAdd = DOMAIN_WRITERS.family_capture.add.bind(DOMAIN_WRITERS.family_capture);
    DOMAIN_WRITERS.family_capture.add = async (intent, rawPhrase, ctx) => {
      addCalls += 1;
      lastAddIntent = intent;
      return originalAdd(intent, rawPhrase, ctx);
    };
    try {
      const llmIntent = {
        type: 'family_capture',
        relation: 'wife',
        name: 'Shannon',
      };
      const t1 = await applyIntents([llmIntent], 'my wife is Shannon', session, undefined, 'llm');
      const c0 = t1.commits[0];
      assert(
        'P4a llm family_capture first turn is status:pending (LLM confirm gate)',
        c0,
        (v) => !!v && v.status === 'pending',
        "status: 'pending'",
      );
      assert(
        "P4b llm confirm prompt is exactly \"Say yes and I'll remember that.\"",
        c0 && c0.status === 'pending' ? c0.prompt : null,
        (v) => v === "Say yes and I'll remember that.",
        "Say yes and I'll remember that.",
      );
      assert(
        'P4c llm confirm CommitResult carries a resume closure',
        c0 && c0.status === 'pending' ? typeof c0.resume : null,
        (v) => v === 'function',
        'function',
      );
      assert(
        'P4d writer.add NOT called on first turn for source:llm',
        addCalls,
        (v) => v === 0,
        '0 add calls',
      );
      assert(
        'P4e nothing written to DB before LLM confirm yes',
        rows().length,
        (v) => v === 0,
        '0 rows',
      );

      // Case 2: yes is detected inside the resume closure (CONFIRM_YES_RE),
      // not by resolvePending itself — then writer.add runs once verbatim.
      const callsBeforeYes = addCalls;
      await session.resolvePending('yes');
      assert(
        'P4f yes on LLM confirm invokes writer.add exactly once',
        { addCalls, delta: addCalls - callsBeforeYes },
        (v) => v.addCalls === 1 && v.delta === 1,
        'addCalls 0→1 on the yes turn',
      );
      assert(
        'P4g writer.add received the original intent verbatim',
        lastAddIntent,
        (v) => !!v && v.type === 'family_capture' && v.name === 'Shannon' && v.relation === 'wife',
        'family_capture Shannon/wife',
      );
      // family_capture.add itself returns a domain confirm pending — finish it.
      if (session.hasPending()) {
        await session.resolvePending('yes');
      }
      assert(
        'P4h after confirm chain, Shannon/wife is committed',
        rows(),
        (v) => v.length === 1 && v[0].name === 'Shannon' && v[0].relationship === 'wife',
        '1 row, Shannon/wife',
      );
    } finally {
      DOMAIN_WRITERS.family_capture.add = originalAdd;
    }
  }

  // Case 3: source:deterministic — unchanged from today's writer-first path.
  {
    const { session, rows } = freshPipeline();
    let addCalls = 0;
    const originalAdd = DOMAIN_WRITERS.family_capture.add.bind(DOMAIN_WRITERS.family_capture);
    DOMAIN_WRITERS.family_capture.add = async (intent, rawPhrase, ctx) => {
      addCalls += 1;
      return originalAdd(intent, rawPhrase, ctx);
    };
    try {
      const detIntent = {
        type: 'family_capture',
        relation: 'daughter',
        name: 'Emma',
      };
      const t1 = await applyIntents([detIntent], 'my daughter is Emma', session, undefined, 'deterministic');
      const c0 = t1.commits[0];
      assert(
        'P4i deterministic family_capture calls writer.add on first turn',
        addCalls,
        (v) => v === 1,
        '1 add call',
      );
      assert(
        'P4j deterministic keeps domain confirm — no LLM gate prompt',
        c0,
        (v) =>
          !!v &&
          v.status === 'pending' &&
          typeof v.prompt === 'string' &&
          v.prompt.includes('Emma') &&
          v.prompt.includes('daughter') &&
          v.prompt !== "Say yes and I'll remember that.",
        'domain confirm naming Emma/daughter',
      );
      await session.resolvePending('yes');
      assert(
        'P4k deterministic yes commits Emma/daughter (no Build C gate)',
        rows(),
        (v) => v.length === 1 && v[0].name === 'Emma' && v[0].relationship === 'daughter',
        '1 row, Emma/daughter',
      );
    } finally {
      DOMAIN_WRITERS.family_capture.add = originalAdd;
    }
  }

  // Case 4: source:llm for a type with NO registered writer — silently dropped.
  {
    const { session, rows } = freshPipeline();
    const t1 = await applyIntents(
      [{ type: 'pass' }],
      'can you hear me',
      session,
      undefined,
      'llm',
    );
    assert(
      'P4l llm intent with no DOMAIN_WRITER is silently dropped (empty commits)',
      { commits: t1.commits.length, pending: session.hasPending(), rows: rows().length },
      (v) => v.commits === 0 && v.pending === false && v.rows === 0,
      '0 commits, no pending, 0 rows',
    );
  }

  // ── P5: ChatScreen:1214 source:'llm' — FEATURE pins (was DEFECT when source omitted) ──
  // Fixed call site passes 'llm' explicitly; Build C gate must arm before writer.add.
  {
    const { session, rows } = freshPipeline();
    let addCalls = 0;
    const originalAdd = DOMAIN_WRITERS.family_capture.add.bind(DOMAIN_WRITERS.family_capture);
    DOMAIN_WRITERS.family_capture.add = async (intent, rawPhrase, ctx) => {
      addCalls += 1;
      return originalAdd(intent, rawPhrase, ctx);
    };
    try {
      // Fixed ChatScreen.tsx:1214 shape — source:'llm' required 5th arg.
      const llmShapedIntent = {
        type: 'family_capture',
        relation: 'son',
        name: 'Hunter',
      };
      const t1 = await applyIntents(
        [llmShapedIntent],
        'my son is Hunter',
        session,
        { resolveContact: undefined },
        'llm',
      );
      const c0 = t1.commits[0];
      assert(
        'P5a FEATURE-PIN ChatScreen:1214 source:llm → writer.add NOT called on first turn',
        addCalls,
        (v) => v === 0,
        '0 add calls (Build C gate armed)',
      );
      assert(
        'P5b FEATURE-PIN source:llm → LLM confirm gate prompt',
        c0,
        (v) =>
          !!v &&
          v.status === 'pending' &&
          v.prompt === "Say yes and I'll remember that.",
        "Say yes and I'll remember that.",
      );
      assert(
        'P5c FEATURE-PIN source:llm → nothing written before confirm yes',
        rows().length,
        (v) => v === 0,
        '0 rows',
      );
    } finally {
      DOMAIN_WRITERS.family_capture.add = originalAdd;
    }
  }

  // ── P6: medical read pending continuation (2026-08-15) ──
  function seedTwoDoctorOutcomes() {
    const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(smithId, 'Smith said to continue the current dose.');
  }

  {
    const { say, session } = freshPipeline();
    seedTwoDoctorOutcomes();
    const tA = await say('What did my doctor tell me?');
    assert('P6a ambiguous trigger asks which doctor', tA,
      (v) => v.handled === true && v.source === 'capture' && v.responseText === 'Which doctor do you mean?',
      "handled:true source:capture 'Which doctor do you mean?'");
    assert('P6b pending armed', session.hasPending(), (v) => v === true, 'true');

    const tB = await say('Patel');
    assert('P6c resumes to Patel outcome', tB,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText.includes('labs were unremarkable')
        && !v.responseText.includes('continue the current dose'),
      'Patel outcome, pending_resume, no Smith leak');
    assert('P6d pending cleared after resolve', session.hasPending(), (v) => v === false, 'false');
  }

  {
    const { say, session } = freshPipeline();
    seedTwoDoctorOutcomes();
    await say('What did my doctor tell me?');
    const tC = await say('Smith');
    assert('P6e resumes to Smith outcome', tC,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText.includes('continue the current dose'),
      'Smith outcome, pending_resume');
    assert('P6f Smith path does not leak Patel', tC,
      (v) => v.handled === true && !v.responseText.includes('labs were unremarkable'),
      'excludes Patel outcome');
    assert('P6f2 pending cleared after Smith resolve', session.hasPending(), (v) => v === false, 'false');
  }

  {
    const { say, session } = freshPipeline();
    seedTwoDoctorOutcomes();
    await say('What did my doctor tell me?');
    const tD = await say('banana');
    assert('P6g invalid reply re-asks and retains pending', tD,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText === 'I mean Dr. Patel or Dr. Smith — which one?',
      'named-pair reask');
    assert('P6g2 pending retained after invalid reply', session.hasPending(), (v) => v === true, 'true');
  }

  {
    const { say, session } = freshPipeline();
    seedTwoDoctorOutcomes();
    await say('What did my doctor tell me?');
    const tE = await say('never mind');
    assert('P6h cancel clears pending', session.hasPending(), (v) => v === false, 'false');
    assert('P6h2 cancel does not speak an outcome', tE,
      (v) => v.handled === true && v.source === 'pending_resume'
        && !v.responseText.includes('labs were unremarkable')
        && !v.responseText.includes('continue the current dose'),
      'no outcome text');
  }

  {
    const { say, session } = freshPipeline();
    const namedId = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'named visit', visit_date: '2026-05-01' });
    attachVisitOutcome(namedId, 'Alvarez said the blood pressure was improved.');
    const nullId = writeMedicalRecord({ notes: 'unattributed visit', visit_date: '2026-07-20' });
    attachVisitOutcome(nullId, 'Unattributed follow-up notes, no doctor recorded.');

    const tF = await say('What did my doctor tell me?');
    assert('P6i named+unattributed asks which doctor and does not auto-commit', tF,
      (v) => v.handled === true && v.source === 'capture'
        && v.responseText === 'Which doctor do you mean?'
        && !v.responseText.includes('blood pressure was improved')
        && !v.responseText.includes('Unattributed follow-up'),
      "clarify only; no named or unattributed outcome");
    assert('P6i2 pending armed without auto-commit', session.hasPending(), (v) => v === true, 'true');
    assert('P6i3 candidate set is exactly the one nameable doctor',
      getAmbiguousDoctorCandidates(),
      (v) => Array.isArray(v) && v.length === 1 && v[0] === 'Dr. Alvarez',
      "['Dr. Alvarez']");

    const tG = await say('Alvarez');
    assert('P6j resumes to Alvarez outcome without unattributed leak', tG,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText.includes('blood pressure was improved')
        && !v.responseText.includes('Unattributed follow-up'),
      'Alvarez outcome, pending_resume, no unattributed leak');
    assert('P6j2 pending cleared after named+unattributed resolve', session.hasPending(), (v) => v === false, 'false');
  }

  // ── P6k–P6o: >2 named candidates — generic reask, never a roster (2026-08-16)
  const GENERIC_DOCTOR_REASK =
    "I'm not sure I'm following — can you say the doctor's name again?";
  const PATEL_OUTCOME = 'Patel said the labs were unremarkable.';
  const SMITH_OUTCOME = 'Smith said to continue the current dose.';
  const FOSTER_OUTCOME = 'Foster said blood pressure was elevated.';

  function seedThreeDoctorOutcomes() {
    const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(patelId, PATEL_OUTCOME);
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-06-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(fosterId, FOSTER_OUTCOME);
  }

  function hasRosterOrOutcome(text: string): boolean {
    return /I mean Dr/i.test(text)
      || text.includes(PATEL_OUTCOME)
      || text.includes(SMITH_OUTCOME)
      || text.includes(FOSTER_OUTCOME);
  }

  {
    const { say, session } = freshPipeline();
    seedThreeDoctorOutcomes();
    const tK = await say('What did my doctor say?');
    assert('P6k first ask remains Which doctor do you mean?', tK,
      (v) => v.handled === true && v.source === 'capture'
        && v.responseText === 'Which doctor do you mean?',
      "Which doctor do you mean?");
    assert('P6k2 pending armed', session.hasPending(), (v) => v === true, 'true');

    const tL = await say('Dr Sarver');
    assert('P6l Dr Sarver → generic one-question reask', tL,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText === GENERIC_DOCTOR_REASK
        && !hasRosterOrOutcome(v.responseText),
      GENERIC_DOCTOR_REASK);
    assert('P6l2 pending remains active after Dr Sarver', session.hasPending(),
      (v) => v === true, 'true');
  }

  {
    const { say, session } = freshPipeline();
    seedThreeDoctorOutcomes();
    await say('What did my doctor say?');
    const tM = await say('Sarver');
    assert('P6m bare Sarver → same generic non-menu reask', tM,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText === GENERIC_DOCTOR_REASK
        && !hasRosterOrOutcome(v.responseText),
      GENERIC_DOCTOR_REASK);
    assert('P6m2 pending remains active after Sarver', session.hasPending(),
      (v) => v === true, 'true');
  }

  {
    const { say, session } = freshPipeline();
    seedThreeDoctorOutcomes();
    await say('What did my doctor say?');
    const tN = await say('Dr Patel');
    assert('P6n Dr Patel resolves Patel outcome only', tN,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(SMITH_OUTCOME)
        && !v.responseText.includes(FOSTER_OUTCOME),
      'Patel outcome, no Smith/Foster leak');
    assert('P6n2 pending cleared after Dr Patel', session.hasPending(),
      (v) => v === false, 'false');
  }

  {
    const { say, session } = freshPipeline();
    seedThreeDoctorOutcomes();
    await say('What did my doctor say?');
    const tO = await say('Patel');
    assert('P6o bare Patel resolves Patel outcome only', tO,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(SMITH_OUTCOME)
        && !v.responseText.includes(FOSTER_OUTCOME),
      'Patel outcome, no Smith/Foster leak');
    assert('P6o2 pending cleared after Patel', session.hasPending(),
      (v) => v === false, 'false');
  }

  // P5d: REQUIRED-source compile pin — NOT CHECKABLE in this harness.
  // source is now required (no default). run.mjs is tsx-only and never runs
  // tsc, so @ts-expect-error on an omitted 5th arg is still not validated here:
  //   // @ts-expect-error source is required — omit 5th arg must error
  //   applyIntents([], 'x', new ConversationSession(), undefined);
  console.log(
    `${DIM}P5d SKIP  REQUIRED-source @ts-expect-error — harness is tsx runtime, no tsc${RESET}`,
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}Pipeline: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}
