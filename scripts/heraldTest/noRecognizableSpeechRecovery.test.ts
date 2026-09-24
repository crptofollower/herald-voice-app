// scripts/heraldTest/noRecognizableSpeechRecovery.test.ts
// Voice-recognition state-leak repair — CTO acceptance suite.
//
// Proves: a genuine content-free recognition outcome (no transcript, no
// partial — true silence/no-speech) while a pending confirmation is armed
// now advances the EXISTING ConversationSession re-ask/budget/release
// ladder instead of leaking the pending indefinitely — and that an
// ordinary silent mic press with no pending armed remains an untouched
// no-op. No transcript text is ever fabricated: every call below passes
// the literal empty string, exactly as the real repair does.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDB } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';

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

function medicalRecordsCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as n FROM medical_records').get() as any).n;
}

const chatScreenPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx');
const useMicPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/hooks/useMic.ts');

export async function runNoRecognizableSpeechRecoveryTests() {
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

  async function establishMedicalPending(session: ConversationSession) {
    await processUtterance('I saw Dr. Smith yesterday.', session, freshDb().deps, null, null, null, null, null, null, null);
  }

  console.log(`\n${BOLD}-- (1) Recognized yes/no confirmation behavior remains unchanged --${RESET}`);
  {
    const { db, session, deps } = freshDb();
    await processUtterance('I saw Dr. Smith yesterday.', session, deps, null, null, null, null, null, null, null);
    assertTrue('setup: medical_visit pending armed', session.hasPending());
    const outcome = await processUtterance('Yes.', session, deps, null, null, null, null, null, null, null);
    assertTrue('unchanged: "Yes." still commits the visit', outcome.handled === true && outcome.source === 'pending_resume');
    assert('unchanged: exactly one medical_records write', medicalRecordsCount(db), 1);
    assertTrue('unchanged: pending cleared on real commit', !session.hasPending());
  }

  console.log(`\n${BOLD}-- (2) No-speech while pending advances the ladder, does not leak --${RESET}`);
  {
    const { session, deps } = freshDb();
    await processUtterance('I saw Dr. Smith yesterday.', session, deps, null, null, null, null, null, null, null);
    assertTrue('setup: pending armed', session.hasPending());

    // The repair's exact mechanism: feed the literal empty string (never a
    // fabricated transcript) into processUtterance while a pending exists —
    // this is what ChatScreen's new handleNoRecognizableSpeech does.
    const outcome = await processUtterance('', session, deps, null, null, null, null, null, null, null);
    assertTrue('no-speech: still handled as a pending resume (re-ask ladder engaged)', outcome.handled === true && outcome.source === 'pending_resume');
    assertTrue('no-speech: pending NOT cleared after a single silent failure (budget not yet exhausted)', session.hasPending());
    assertTrue('no-speech: response is a re-ask, not a fabricated commit/decline', outcome.handled && outcome.source !== 'emergency' && /not sure|following|say that again/i.test(outcome.responseText));
  }

  console.log(`\n${BOLD}-- (3) Repeated no-speech eventually releases the pending per existing budget --${RESET}`);
  {
    const { session, deps } = freshDb();
    await processUtterance('I saw Dr. Smith yesterday.', session, deps, null, null, null, null, null, null, null);
    assertTrue('setup: pending armed', session.hasPending());

    // DEFAULT_STANDARD_BUDGET = 2 re-asks before release (conversationSession.ts).
    await processUtterance('', session, deps, null, null, null, null, null, null, null);
    assertTrue('after 1st silent failure: still armed (budget not exhausted)', session.hasPending());
    const finalOutcome = await processUtterance('', session, deps, null, null, null, null, null, null, null);
    assertTrue('after budget exhausted: pending is released, not leaked', !session.hasPending());
    assertTrue('release: response is the honest release ack, not silence', finalOutcome.handled === true && finalOutcome.source !== 'emergency' && finalOutcome.responseText.length > 0);
  }

  console.log(`\n${BOLD}-- (4) Once released, the next mic press's own hasPending() check reads false --${RESET}`);
  {
    // ChatScreen.tsx:~3633's micMode ternary reads sessionRef.current.hasPending()
    // directly and is not itself re-testable in this harness (JSX/onPress) —
    // this proves the underlying boolean the ternary depends on is correct
    // after release, which is the entire behavioral claim.
    const { session, deps } = freshDb();
    await processUtterance('I saw Dr. Smith yesterday.', session, deps, null, null, null, null, null, null, null);
    await processUtterance('', session, deps, null, null, null, null, null, null, null);
    await processUtterance('', session, deps, null, null, null, null, null, null, null); // exhausts budget
    const micModeAfterRelease = session.hasPending() ? 'control_confirmation' : 'open';
    assert('mic mode after release resolves to open, not control_confirmation', micModeAfterRelease, 'open');
  }

  console.log(`\n${BOLD}-- (5) No-speech with no pending remains a no-op --${RESET}`);
  {
    const { db, session, deps } = freshDb();
    assertTrue('setup: no pending armed', !session.hasPending());
    // This demonstrates why ChatScreen's guard (!sessionRef.current.hasPending()
    // -> return, never call processUtterance) is load-bearing: calling
    // processUtterance('') WITHOUT that guard is not a no-op — it proceeds to
    // ordinary routing instead of silently doing nothing.
    const outcomeWithoutGuard = await processUtterance('', session, deps, null, null, null, null, null, null, null);
    assertTrue(
      'proof the guard is necessary: an unguarded empty-string call does NOT no-op, it routes',
      outcomeWithoutGuard.handled === false,
    );
    assert('no writes occur either way', medicalRecordsCount(db), 0);

    const src = fs.readFileSync(chatScreenPath, 'utf8');
    assertTrue(
      'source-lock: handleNoRecognizableSpeech guards on sessionRef.current.hasPending() before calling processUtterance',
      /if \(sendingRef\.current \|\| !sessionRef\.current\.hasPending\(\)\) return;/.test(src),
    );
  }

  console.log(`\n${BOLD}-- (6) Medical deterministic capture/confirmation authority untouched --${RESET}`);
  {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/routeIntent.ts'),
      'utf8',
    );
    assertTrue('CONFIRM_YES_RE/CONFIRM_NO_RE import site in medical_visit unchanged (still imported from conversationSession)', /const \{ CONFIRM_YES_RE, CONFIRM_NO_RE \} = await import\('\.\/conversationSession'\);/.test(src));
    const { db, session, deps } = freshDb();
    await processUtterance('I saw Dr. Smith yesterday.', session, deps, null, null, null, null, null, null, null);
    const declined = await processUtterance('No.', session, deps, null, null, null, null, null, null, null);
    assertTrue('deterministic decline still works, unaffected', declined.handled === true);
    assert('decline performs zero writes', medicalRecordsCount(db), 0);
  }

  console.log(`\n${BOLD}-- (7) useMic.ts: onNoRecognizableSpeech fires only from the two authorized branches, never fabricates text --${RESET}`);
  {
    const src = fs.readFileSync(useMicPath, 'utf8');
    const occurrences = (src.match(/onNoRecognizableSpeech\?\.\(\)/g) ?? []).length;
    assert('exactly two call sites (no-speech error teardown, native end silence/heard_unrecognized)', occurrences, 2);
    assertTrue('callback signature carries no text parameter (cannot fabricate a transcript)', /onNoRecognizableSpeech\?: \(\) => void/.test(src));
    assertTrue(
      'the "flush" (real transcript) branch still returns before reaching the no-speech callback',
      /decideOneShotNoSpeech\([\s\S]*?\) === 'flush'\) \{[\s\S]{0,200}?return;\s*\}[\s\S]{0,600}?onNoRecognizableSpeech\?\.\(\);/.test(src),
    );
  }

  console.log(`\n${BOLD}-- (8) ChatScreen wiring: useMic receives the new callback as its third argument --${RESET}`);
  {
    const src = fs.readFileSync(chatScreenPath, 'utf8');
    assertTrue(
      'useMic(handleTranscript, isSpeakingRef, handleNoRecognizableSpeech) wired',
      /useMic\(\s*handleTranscript,\s*isSpeakingRef,\s*handleNoRecognizableSpeech\b/.test(src),
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}NoRecognizableSpeechRecovery: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('noRecognizableSpeechRecovery.test.ts')) {
  runNoRecognizableSpeechRecoveryTests().catch(console.error);
}
