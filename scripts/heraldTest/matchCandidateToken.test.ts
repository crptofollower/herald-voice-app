// scripts/heraldTest/matchCandidateToken.test.ts
// Direct contract for the shared matchCandidateToken() helper, plus the
// device-proven medical visit-outcome leak (one named + unattributed,
// reply "Dr Sarver" must not return Patel).
//
// Runner: npx tsx scripts/heraldTest/matchCandidateToken.test.ts
// Gate:   wired from run.mjs.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeMedicalRecord, attachVisitOutcome } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import {
  ConversationSession,
  matchCandidateToken,
  type MatchableCandidate,
} from '../../src/routing/conversationSession.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const PATEL: MatchableCandidate = { label: 'Dr. Patel', ref: 'Dr. Patel' };
const SMITH: MatchableCandidate = { label: 'Dr. Smith', ref: 'Dr. Smith' };
const ALVAREZ: MatchableCandidate = { label: 'Dr. Alvarez', ref: 'Dr. Alvarez' };
const CLEVENGER: MatchableCandidate = { label: 'David Clevenger', ref: 'clev' };
const MOSSHOLDER: MatchableCandidate = { label: 'David Mossholder', ref: 'moss' };
const MY_DAD: MatchableCandidate = { label: 'My Dad', ref: 'my-dad' };
const MIKES_DAD: MatchableCandidate = { label: 'Mikes Dad', ref: 'mikes-dad' };
const DAD_HOME: MatchableCandidate = { label: 'Dad-home', ref: 'dad-home' };
const MILK: MatchableCandidate = { label: '2% milk', ref: 'milk' };
const BREAD: MatchableCandidate = { label: 'bread', ref: 'bread' };
const ALMOND_MILK: MatchableCandidate = { label: 'almond milk', ref: 'almond' };

function pickedLabel(result: ReturnType<typeof matchCandidateToken>): string | typeof result {
  return typeof result === 'object' ? result.label : result;
}

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

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshPipeline() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [], lists: [] },
  };
  const say = (text: string) => processUtterance(text, session, deps);
  return { session, say };
}

function seedPatelPlusUnattributed() {
  const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-05-01' });
  attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
  const nullId = writeMedicalRecord({ notes: 'unattributed visit', visit_date: '2026-07-20' });
  attachVisitOutcome(nullId, 'Unattributed follow-up notes, no doctor recorded.');
}

export async function runMatchCandidateTokenTests(): Promise<{ passed: number; failed: number; total: number }> {
  let passed = 0;
  let failed = 0;
  const assert = (label: string, value: unknown, pred: (v: any) => boolean, detail: string) => {
    if (pred(value)) {
      passed++;
      console.log(`${GREEN}✅ PASS${RESET}  ${label}\n      ${DIM}${detail}${RESET}\n`);
    } else {
      failed++;
      console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}${detail}${RESET}\n      ${RED}got: ${JSON.stringify(value)}${RESET}\n`);
    }
  };

  console.log(`\n${BOLD}-- matchCandidateToken Direct Tests --------------------${RESET}\n`);

  assert('MCT-1 exact "Dr Patel" → Dr. Patel',
    pickedLabel(matchCandidateToken('Dr Patel', [PATEL])),
    v => v === 'Dr. Patel',
    'punctuation-normalized exact');

  assert('MCT-2 distinctive "Patel" → Dr. Patel',
    pickedLabel(matchCandidateToken('Patel', [PATEL])),
    v => v === 'Dr. Patel',
    'unique identity token');

  assert('MCT-3 "Dr Sarver" vs singleton Dr. Patel → none',
    matchCandidateToken('Dr Sarver', [PATEL]),
    v => v === 'none',
    'honorific overlap must not select Patel');

  assert('MCT-4 "Dr Smith" vs singleton Dr. Patel → none',
    matchCandidateToken('Dr Smith', [PATEL]),
    v => v === 'none',
    'wrong surname after honorific strip');

  assert('MCT-5 bare "Dr" vs singleton Dr. Patel → none',
    matchCandidateToken('Dr', [PATEL]),
    v => v === 'none',
    'title-only reply is no-match');

  assert('MCT-6 two doctors + "Dr Sarver" → none',
    matchCandidateToken('Dr Sarver', [PATEL, SMITH]),
    v => v === 'none',
    'remaining token sarver hits neither; never a single pick');

  assert('MCT-7 duplicated first name "David" → ambiguous',
    matchCandidateToken('David', [CLEVENGER, MOSSHOLDER]),
    v => v === 'ambiguous',
    'shared first name must not auto-pick');

  assert('MCT-8 unique surname "Clevenger" → David Clevenger',
    pickedLabel(matchCandidateToken('Clevenger', [CLEVENGER, MOSSHOLDER])),
    v => v === 'David Clevenger',
    'unique contact surname partial');

  assert('MCT-9 exact "My Dad" among Dad variants',
    pickedLabel(matchCandidateToken('My Dad', [MIKES_DAD, MY_DAD, DAD_HOME])),
    v => v === 'My Dad',
    'exact full-label');

  assert('MCT-10 list distinctive partial "milk" → 2% milk',
    pickedLabel(matchCandidateToken('milk', [MILK, BREAD])),
    v => v === '2% milk',
    'unique list-item token');

  assert('MCT-11 two list items sharing "milk" → ambiguous',
    matchCandidateToken('milk', [MILK, ALMOND_MILK]),
    v => v === 'ambiguous',
    'shared partial must not auto-pick');

  assert('MCT-12 empty reply → none',
    matchCandidateToken('   ', [PATEL]),
    v => v === 'none',
    'whitespace-only is no-match');

  assert('MCT-13 singleton identity "Alvarez" → Dr. Alvarez',
    pickedLabel(matchCandidateToken('Alvarez', [ALVAREZ])),
    v => v === 'Dr. Alvarez',
    'identity-bearing token on singleton');

  assert('MCT-14 title "doctor" vs Dr. Patel → none',
    matchCandidateToken('doctor', [PATEL]),
    v => v === 'none',
    'closed-set token doctor');

  assert('MCT-15 title "Mr" vs Mr. Smith → none',
    matchCandidateToken('Mr', [{ label: 'Mr. Smith', ref: 'smith' }]),
    v => v === 'none',
    'closed-set token mr');

  assert('MCT-16 title "Mrs" vs Mrs. Jones → none',
    matchCandidateToken('Mrs', [{ label: 'Mrs. Jones', ref: 'jones' }]),
    v => v === 'none',
    'closed-set token mrs');

  assert('MCT-17 title "Ms" vs Ms. Lee → none',
    matchCandidateToken('Ms', [{ label: 'Ms. Lee', ref: 'lee' }]),
    v => v === 'none',
    'closed-set token ms');

  assert('MCT-18 title "Miss" vs Miss Taylor → none',
    matchCandidateToken('Miss', [{ label: 'Miss Taylor', ref: 'taylor' }]),
    v => v === 'none',
    'closed-set token miss');

  assert('MCT-19 title "Mister" vs Mister Brown → none',
    matchCandidateToken('Mister', [{ label: 'Mister Brown', ref: 'brown' }]),
    v => v === 'none',
    'closed-set token mister');

  assert('MCT-20 "doctor Patel" still selects Dr. Patel',
    pickedLabel(matchCandidateToken('doctor Patel', [PATEL])),
    v => v === 'Dr. Patel',
    'honorific stripped; remaining identity token unique');

  console.log(`\n${BOLD}-- matchCandidateToken Medical Leak (processUtterance) --${RESET}\n`);

  const PATEL_OUTCOME = 'Patel said the labs were unremarkable.';
  const UNATTRIBUTED = 'Unattributed follow-up notes, no doctor recorded.';
  const ASK = 'What did my doctor say?';
  const GENERIC_REASK = "I'm not sure I'm following — can you say the doctor's name again?";

  {
    const { say, session } = freshPipeline();
    seedPatelPlusUnattributed();
    const tA = await say(ASK);
    assert('MCT-L1 named+unattributed asks which doctor', tA,
      (v) => v.handled === true && v.source === 'capture'
        && v.responseText === 'Which doctor do you mean?'
        && !v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(UNATTRIBUTED),
      "Which doctor do you mean?; no outcome leak");
    assert('MCT-L2 pending armed', session.hasPending(), (v) => v === true, 'true');

    const tB = await say('Dr Sarver');
    assert('MCT-L3 Dr Sarver does not return Patel outcome', tB,
      (v) => v.handled === true && v.source === 'pending_resume'
        && !v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(UNATTRIBUTED),
      'no Patel or unattributed outcome');
    assert('MCT-L4 Dr Sarver reasks and keeps pending', tB,
      (v) => v.responseText === GENERIC_REASK, GENERIC_REASK);
    assert('MCT-L5 pending remains after Dr Sarver', session.hasPending(),
      (v) => v === true, 'true');
  }

  {
    const { say, session } = freshPipeline();
    seedPatelPlusUnattributed();
    await say(ASK);
    const tC = await say('Dr Smith');
    assert('MCT-L6 Dr Smith does not return Patel outcome', tC,
      (v) => v.handled === true && v.source === 'pending_resume'
        && !v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(UNATTRIBUTED)
        && v.responseText === GENERIC_REASK,
      'fail-closed reask; no leak');
    assert('MCT-L7 pending remains after Dr Smith', session.hasPending(),
      (v) => v === true, 'true');
  }

  {
    const { say, session } = freshPipeline();
    seedPatelPlusUnattributed();
    await say(ASK);
    const tD = await say('Dr');
    assert('MCT-L8 bare Dr does not return Patel outcome', tD,
      (v) => v.handled === true && v.source === 'pending_resume'
        && !v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(UNATTRIBUTED)
        && v.responseText === GENERIC_REASK,
      'title-only fail-closed');
    assert('MCT-L9 pending remains after bare Dr', session.hasPending(),
      (v) => v === true, 'true');
  }

  {
    const { say, session } = freshPipeline();
    seedPatelPlusUnattributed();
    await say(ASK);
    const tE = await say('Patel');
    assert('MCT-L10 "Patel" resumes Patel outcome only', tE,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(UNATTRIBUTED),
      'Patel outcome; no unattributed leak');
    assert('MCT-L11 pending cleared after Patel', session.hasPending(),
      (v) => v === false, 'false');
  }

  {
    const { say, session } = freshPipeline();
    seedPatelPlusUnattributed();
    await say(ASK);
    const tF = await say('Dr Patel');
    assert('MCT-L12 "Dr Patel" resumes Patel outcome only', tF,
      (v) => v.handled === true && v.source === 'pending_resume'
        && v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(UNATTRIBUTED),
      'exact Dr Patel; no unattributed leak');
    assert('MCT-L13 pending cleared after Dr Patel', session.hasPending(),
      (v) => v === false, 'false');
  }

  console.log(`${BOLD}matchCandidateToken: ${passed} passed / ${failed} failed / ${passed + failed} total${RESET}\n`);
  return { passed, failed, total: passed + failed };
}

if (process.argv[1]?.endsWith('matchCandidateToken.test.ts')) {
  const r = await runMatchCandidateTokenTests();
  process.exit(r.failed > 0 ? 1 : 0);
}
