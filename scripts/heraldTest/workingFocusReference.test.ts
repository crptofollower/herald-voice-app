// Working-focus reference continuation. Proposal admits one doctor focus.
// It does not parse the utterance and it does not invent an identity.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { setDB, runMigrations, getDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { admitWorkingFocusReference } from '../../src/routing/workingFocusReference.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

export async function runWorkingFocusReferenceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${JSON.stringify(got)}\n       expected: ${expected}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Working Focus Reference Continuation --${RESET}\n`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(root, 'src/routing/workingFocusReference.ts'), 'utf8');
  assert('admission does not parse wording or names',
    !src.includes('RegExp') && !src.includes('.test(') && !src.toLowerCase().includes('patel') && !src.includes('him'),
    (v) => v === true, 'no grammar');

  const one = { domain: 'medical_doctor', entityId: 'Dr. Patel', displayName: 'Dr. Patel' };
  const two = { domain: 'medical_doctor', entityId: 'Dr. Shah', displayName: 'Dr. Shah' };
  assert('one compatible focus is admitted',
    admitWorkingFocusReference({ applicable: true }, [one]).kind === 'admit',
    (v) => v === true, 'admit');
  assert('a non-reference proposal does not admit',
    admitWorkingFocusReference({ applicable: false }, [one]).kind === 'none'
      && admitWorkingFocusReference(null, [one]).kind === 'none',
    (v) => v === true, 'none');
  assert('zero compatible focus does not invent an identity',
    admitWorkingFocusReference({ applicable: true }, [{ domain: 'family', entityId: 'x', displayName: 'Maya' }]).kind === 'none',
    (v) => v === true, 'none');
  assert('two compatible focuses clarify',
    admitWorkingFocusReference({ applicable: true }, [one, two]).kind === 'clarify',
    (v) => v === true, 'clarify');

  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  db.prepare(
    `INSERT INTO medical_records (id, visit_date, doctor_name, notes, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('visit_patel', '2026-09-01', 'Dr. Patel', 'Checkup', '2026-09-01T15:00:00.000Z');

  const applicable = {
    completion: async () => ({ text: 'applicable' }),
  };
  const subject = new ConversationalSubjectHolder();
  subject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const followed = await processUtterance(
    'zz reference',
    new ConversationSession(),
    {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
      getMedicationSemanticInterpreterCtx: () => applicable,
    },
    subject,
  );
  assert('the admitted focus is re-read by the visit reader',
    followed.handled === true
      && followed.responseText.includes('Patel')
      && followed.responseAct?.kind === 'ANSWER'
      && subject.peek()?.domain === 'medical_doctor',
    (v) => v === true, 'reader');
  assert('the model text is not the spoken fact',
    followed.responseText !== 'applicable',
    (v) => v === true, 'reader speech');

  const itemsBefore = getDB().getAllSync<{ body: string }>('SELECT body FROM list_items');
  const grocerySubject = new ConversationalSubjectHolder();
  grocerySubject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const grocery = await processUtterance(
    'Add milk to my grocery list.',
    new ConversationSession(),
    {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
      getMedicationSemanticInterpreterCtx: () => ({ completion: async () => ({ text: 'not' }) }),
    },
    grocerySubject,
  );
  const itemsAfter = getDB().getAllSync<{ body: string }>('SELECT body FROM list_items WHERE removed_at IS NULL');
  assert('a non-reference grocery add still writes milk',
    grocery.handled === true && itemsAfter.some((row) => row.body === 'milk') && itemsBefore.length === 0,
    (v) => v === true, 'milk');

  const total = passed + failures.length;
  console.log(`\n${BOLD}WorkingFocusReference: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('workingFocusReference.test');
if (invokedDirectly) {
  runWorkingFocusReferenceTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
