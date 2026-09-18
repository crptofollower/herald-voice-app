// scripts/heraldTest/naturalMultiCandidateV1.test.ts
// Natural Conversation Reliability — Multi-Candidate V1, Stage 1.
//
// ConversationSession has exactly ONE authoritative pending slot
// (conversationSession.ts:132, Law 2) and this invariant is unchanged.
// Proves: when applyIntents produces more than one heterogeneous 'pending'
// result in the same turn, chainPendingCandidates (processUtterance.ts)
// preserves the second candidate by chaining it through the first
// candidate's resume closure, rather than losing it -- reusing
// ConversationSession.resolvePending's existing "domain resume advanced to
// a new pending stage" transition (the same mechanism the correction
// ladder already uses), never adding a queue/array to the session class.
//
// Runner: npx tsx scripts/heraldTest/naturalMultiCandidateV1.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { applyIntents, chainPendingCandidates } from '../../src/routing/processUtterance.ts';
import { ConversationSession, CONFIRM_YES_RE, CONFIRM_NO_RE, CANCEL_RE } from '../../src/routing/conversationSession.ts';
import { composeAck } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
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

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

function openItems(db: Database.Database, listName: string): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = ? AND li.checked = 0`,
  ).all(listName) as { body: string }[]).map((r) => r.body);
}

// Minimal synthetic pending CommitResult, for direct chainPendingCandidates
// unit tests -- does not touch any real writer.
function mockPending(
  label: string,
  onResume: (userText: string) => Promise<CommitResult>,
): Extract<CommitResult, { status: 'pending' }> {
  return { status: 'pending', prompt: `Confirm ${label}?`, pendingKey: `mock:${label}`, resume: onResume };
}

export async function runNaturalMultiCandidateV1Tests() {
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

  console.log(`\n${BOLD}-- (1) chainPendingCandidates: unit mechanism, hand-built pendings --${RESET}`);
  {
    const p2 = mockPending('B', async (t) => CONFIRM_YES_RE.test(t.trim()) ? { status: 'committed', ack: 'B done.' } : { status: 'noop', ack: 'B skipped.' });
    const p1 = mockPending('A', async (t) => {
      if (CONFIRM_YES_RE.test(t.trim())) return { status: 'committed', ack: 'A done.' };
      if (CONFIRM_NO_RE.test(t.trim())) return { status: 'noop', ack: 'A skipped.' };
      return { status: 'noop', ack: '' }; // "didn't understand"
    });

    // single pending: identity, no wrapping
    const single = chainPendingCandidates([p1]);
    assertTrue('single pending returned unchanged (no chaining overhead)', single === p1);

    const chained = chainPendingCandidates([p1, p2]);
    assertTrue('chained result speaks candidate 1 prompt first', chained.prompt === 'Confirm A?');

    const unclear = await chained.resume('uhh what');
    assertTrue('unclear reply to candidate 1 does not advance to candidate 2', unclear.status === 'noop' && (unclear as any).ack === '');

    const yesResult = await chained.resume('yes');
    assertTrue('YES on candidate 1 transitions to candidate 2, not a terminal result', yesResult.status === 'pending');
    assert('transition prompt includes candidate 1\'s ack AND candidate 2\'s prompt', (yesResult as any).prompt, 'A done. Confirm B?');
    assert('transition carries candidate 2\'s own pendingKey', (yesResult as any).pendingKey, 'mock:B');

    const finalYes = await (yesResult as any).resume('yes');
    assertTrue('YES on the transitioned pending resolves candidate 2 to a real terminal result', finalYes.status === 'committed' && finalYes.ack === 'B done.');
  }

  console.log(`\n${BOLD}-- (2) chainPendingCandidates: NO on candidate 1 preserves candidate 2 --${RESET}`);
  {
    const p2 = mockPending('B', async (t) => CONFIRM_YES_RE.test(t.trim()) ? { status: 'committed', ack: 'B done.' } : { status: 'noop', ack: 'B skipped.' });
    const p1 = mockPending('A', async (t) => CONFIRM_NO_RE.test(t.trim()) ? { status: 'noop', ack: 'A skipped.' } : { status: 'noop', ack: '' });
    const chained = chainPendingCandidates([p1, p2]);
    const noResult = await chained.resume('no');
    assertTrue('NO on candidate 1 still transitions to candidate 2 (rejection does not corrupt it)', noResult.status === 'pending');
    assert('transition prompt reflects the decline, not a fabricated success', (noResult as any).prompt, 'A skipped. Confirm B?');
    const yesOnB = await (noResult as any).resume('yes');
    assertTrue('candidate 2 still independently confirmable after candidate 1 was declined', yesOnB.status === 'committed');
  }

  console.log(`\n${BOLD}-- (3) applyIntents: homogeneous batching unchanged (regression) --${RESET}`);
  {
    const db = freshDb();
    const intents: IntentRecord[] = [
      { type: 'todo_add', body: 'call the vet' },
      { type: 'todo_add', body: 'pick up dry cleaning' },
    ];
    const session = new ConversationSession();
    const { responseText, commits } = await applyIntents(intents, 'raw', session, undefined, 'llm');
    assertTrue('homogeneous batch produces exactly one pending commit result', commits.length === 1 && commits[0].status === 'pending');
    assertTrue('session has exactly one pending armed', session.hasPending());
    const resolve1 = await session.resolvePending('yes');
    assertTrue('YES commits the whole homogeneous batch together', resolve1.status === 'committed');
    assert('both todo items land in the same commit', openItems(db, 'todos').sort(), ['call the vet', 'pick up dry cleaning'].sort());
    assertTrue('pending cleared after the single-domain batch resolves', !session.hasPending());
  }

  console.log(`\n${BOLD}-- (4) applyIntents: two heterogeneous candidates requiring confirmation --${RESET}`);
  {
    const db = freshDb();
    const intents: IntentRecord[] = [
      { type: 'todo_add', body: 'call my accountant and tell her to file my taxes' },
      { type: 'list_add', items: ['wine'], listName: 'grocery' },
    ];
    const session = new ConversationSession();
    const { responseText, commits } = await applyIntents(intents, 'raw', session, undefined, 'llm');
    assertTrue('two heterogeneous types produce two distinct pending commit results', commits.length === 2 && commits.every((c) => c.status === 'pending'));
    assertTrue('first turn speaks only candidate 1\'s prompt (todo)', responseText.includes('remember') || responseText.length > 0);
    assertTrue('session has exactly one pending armed after a heterogeneous turn', session.hasPending());
    assertTrue('zero writes before any confirmation', openItems(db, 'todos').length === 0 && openItems(db, 'grocery').length === 0);

    const afterFirstYes = await session.resolvePending('yes');
    assertTrue('first YES resolves to a transition (still pending), not terminal', afterFirstYes.status === 'pending');
    assert('candidate 1 (todo) committed after first YES', openItems(db, 'todos'), ['call my accountant and tell her to file my taxes']);
    assertTrue('candidate 2 (grocery) NOT yet written after only the first YES', openItems(db, 'grocery').length === 0);
    assertTrue('session still has a pending armed (candidate 2, now the sole authoritative one)', session.hasPending());

    const afterSecondYes = await session.resolvePending('yes');
    assertTrue('second YES resolves candidate 2 to a terminal result', afterSecondYes.status === 'committed');
    assert('candidate 2 (grocery/wine) committed after second YES', openItems(db, 'grocery'), ['wine']);
    assertTrue('pending fully cleared -- no leakage after both candidates resolve', !session.hasPending());
  }

  console.log(`\n${BOLD}-- (5) First YES cannot accidentally confirm candidate 2 --${RESET}`);
  {
    const db = freshDb();
    const intents: IntentRecord[] = [
      { type: 'todo_add', body: 'call the dentist' },
      { type: 'list_add', items: ['eggs'], listName: 'grocery' },
    ];
    const session = new ConversationSession();
    await applyIntents(intents, 'raw', session, undefined, 'llm');
    await session.resolvePending('yes'); // resolves candidate 1 only
    assert('candidate 2 (grocery) is untouched by the first YES', openItems(db, 'grocery'), []);
    assertTrue('a second, still-armed pending exists for candidate 2 specifically', session.hasPending());
  }

  console.log(`\n${BOLD}-- (6) Rejection (NO) of candidate 1 does not corrupt candidate 2 --${RESET}`);
  {
    const db = freshDb();
    const intents: IntentRecord[] = [
      { type: 'todo_add', body: 'call the dentist' },
      { type: 'list_add', items: ['eggs'], listName: 'grocery' },
    ];
    const session = new ConversationSession();
    await applyIntents(intents, 'raw', session, undefined, 'llm');
    const afterNo = await session.resolvePending('no');
    assertTrue('NO on candidate 1 transitions to candidate 2 rather than terminating the whole turn', afterNo.status === 'pending');
    assert('candidate 1 (todo) NOT written after a decline', openItems(db, 'todos'), []);
    const afterYes = await session.resolvePending('yes');
    assertTrue('candidate 2 still commits correctly after candidate 1 was declined', afterYes.status === 'committed');
    assert('candidate 2 (grocery/eggs) committed', openItems(db, 'grocery'), ['eggs']);
  }

  console.log(`\n${BOLD}-- (7) No candidate silently disappears from the composed ack either --${RESET}`);
  {
    freshDb();
    const intents: IntentRecord[] = [
      { type: 'todo_add', body: 'call the dentist' },
      { type: 'list_add', items: ['eggs'], listName: 'grocery' },
    ];
    const session = new ConversationSession();
    const { commits } = await applyIntents(intents, 'raw', session, undefined, 'llm');
    assertTrue('both candidates are present in the returned commits (nothing dropped from the return value)', commits.length === 2);
  }

  console.log(`\n${BOLD}-- (8) Documented V1 boundary: CANCEL to candidate 1 ends the whole sequence --${RESET}`);
  {
    const db = freshDb();
    const intents: IntentRecord[] = [
      { type: 'todo_add', body: 'call the dentist' },
      { type: 'list_add', items: ['eggs'], listName: 'grocery' },
    ];
    const session = new ConversationSession();
    await applyIntents(intents, 'raw', session, undefined, 'llm');
    assertTrue('CANCEL_RE matches "never mind"', CANCEL_RE.test('never mind'));
    const afterCancel = await session.resolvePending('never mind');
    assertTrue('cancel resolves to a plain noop (documented: ends BOTH candidates, not just candidate 1)', afterCancel.status === 'noop');
    assertTrue('pending fully cleared after cancel', !session.hasPending());
    assert('neither candidate was written', { todos: openItems(db, 'todos'), grocery: openItems(db, 'grocery') }, { todos: [], grocery: [] });
  }

  console.log(`\n${BOLD}-- (9) Pending never leaks: a fresh, unrelated turn after full resolution is not swallowed --${RESET}`);
  {
    freshDb();
    const intents: IntentRecord[] = [
      { type: 'todo_add', body: 'call the dentist' },
      { type: 'list_add', items: ['eggs'], listName: 'grocery' },
    ];
    const session = new ConversationSession();
    await applyIntents(intents, 'raw', session, undefined, 'llm');
    await session.resolvePending('yes');
    await session.resolvePending('yes');
    assertTrue('no pending remains', !session.hasPending());
    assert('an unrelated later utterance resolves to a true no-op (nothing armed to consume it)', await session.resolvePending('whatever else I say now'), { status: 'noop', ack: '' });
  }

  console.log(`\n${BOLD}-- (10) One settled + one pending in one composed ack (existing composeAck contract, unaffected by chaining) --${RESET}`);
  {
    const settled: CommitResult = { status: 'committed', ack: 'Added wine to your grocery list.' };
    const pendingOnly: CommitResult = mockPending('todo', async () => ({ status: 'committed', ack: 'done' }));
    const text = composeAck([settled, pendingOnly]);
    assert('composeAck speaks the settled ack followed by the single pending prompt, unchanged', text, 'Added wine to your grocery list. Confirm todo?');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}NaturalMultiCandidateV1: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('naturalMultiCandidateV1.test.ts')) {
  runNaturalMultiCandidateV1Tests().catch(console.error);
}
