// Conversation Orchestrator Slice 1 — focus lifetime, coexisting Presented Sets,
// structural ordinal admission. Not a phrase patch and not a writer change.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder, ORDERED_PRESENTATION_CONFUSION } from '../../src/routing/orderedPresentation.ts';
import { CalendarPresentationHolder } from '../../src/routing/calendarPresentation.ts';
import { TodoPresentationHolder } from '../../src/routing/todoVisualPresentation.ts';
import { CalendarContinuationHolder } from '../../src/routing/calendarContinuation.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { ReminiscenceArcHolder } from '../../src/routing/reminiscenceArc.ts';
import { RecoveryObligationHolder } from '../../src/routing/recoveryObligation.ts';
import {
  admitStructuralOrdinal,
  presentedSet,
} from '../../src/routing/canonicalConversationState.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function deps() {
  return {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
    getMedicationSemanticInterpreterCtx: () => null,
  };
}

async function world() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  return {
    db,
    session: new ConversationSession(),
    subject: new ConversationalSubjectHolder(),
    medication: new MedicationPresentationHolder(),
    ordered: new OrderedPresentationHolder(),
    calendar: new CalendarPresentationHolder(),
    calendarContinuation: new CalendarContinuationHolder(),
    discourse: new DiscourseContinuityHolder(),
    arc: new ReminiscenceArcHolder(),
    recovery: new RecoveryObligationHolder(),
    todo: new TodoPresentationHolder(),
  };
}

async function say(w: Awaited<ReturnType<typeof world>>, text: string) {
  return processUtterance(
    text,
    w.session,
    deps(),
    w.subject,
    w.medication,
    w.ordered,
    w.calendar,
    w.calendarContinuation,
    w.discourse,
    null,
    w.arc,
    w.recovery,
    w.todo,
  );
}

function speechOf(outcome: Awaited<ReturnType<typeof say>>): string {
  if (outcome.handled && outcome.source !== 'emergency') return outcome.responseText;
  if (!outcome.handled && outcome.routeDecision.kind === 'device_read') return outcome.routeDecision.response;
  return '';
}

export async function runConversationOrchestratorSlice1Tests() {
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

  console.log(`\n${BOLD}-- Conversation Orchestrator Slice 1 --${RESET}\n`);

  const meds = presentedSet('medication', ['med_a', 'med_b']);
  const groceries = presentedSet('grocery', ['item_a', 'item_b']);
  const events = presentedSet('calendar', ['evt_a', 'evt_b']);
  const todos = presentedSet('todo', ['todo_a', 'todo_b']);
  const shortGrocery = presentedSet('grocery', ['only_one']);
  const replaced = presentedSet('grocery', ['new_a', 'new_b']);
  const old = presentedSet('grocery', ['old_a', 'old_b'], 'superseded');

  {
    const one = admitStructuralOrdinal('the second one', [groceries]);
    assert('one live set resolves that set', one.kind === 'unique' && one.kind === 'unique' && one.memberId === 'item_b' && one.domain === 'grocery',
      (v) => v === true, 'grocery item_b');
  }
  {
    const two = admitStructuralOrdinal('the second one', [meds, groceries]);
    assert('two eligible sets clarify', two.kind === 'clarify', (v) => v === true, 'clarify');
  }
  {
    const other = admitStructuralOrdinal('the second one', [events, todos]);
    assert('calendar + to-do is the same non-unique rule', other.kind === 'clarify', (v) => v === true, 'clarify');
  }
  {
    const kept = admitStructuralOrdinal('the second one', [meds, shortGrocery]);
    assert('a shorter set is not eligible for the second position', kept.kind === 'unique' && kept.memberId === 'med_b',
      (v) => v === true, 'med_b');
  }
  {
    const current = admitStructuralOrdinal('the second one', [old, replaced]);
    assert('a superseded set is not eligible', current.kind === 'unique' && current.memberId === 'new_b',
      (v) => v === true, 'new_b');
  }
  {
    const none = admitStructuralOrdinal('hello there', [meds, groceries]);
    assert('a non-ordinal does not clarify', none.kind === 'none', (v) => v === true, 'none');
  }

  {
    const w = await world();
    w.db.prepare(
      `INSERT INTO medical_records (id, visit_date, doctor_name, notes, created_at)
       VALUES ('v1', '2026-09-01', 'Dr. Patel', 'Checkup', '2026-09-01T15:00:00.000Z')`,
    ).run();
    const visit = await say(w, 'When did I last see Dr. Patel?');
    const focusAfterVisit = w.subject.peek();
    const added = await say(w, 'Add milk to my grocery list.');
    const items = w.db.prepare(`SELECT body FROM list_items WHERE removed_at IS NULL`).all() as { body: string }[];
    const visits = w.db.prepare(`SELECT doctor_name FROM medical_records`).all() as { doctor_name: string }[];
    assert('doctor focus is live before the grocery add', !visit.handled && focusAfterVisit?.domain === 'medical_doctor',
      (v) => v === true, 'medical_doctor');
    assert('focus survives the grocery add', w.subject.peek()?.displayName === 'Dr. Patel',
      (v) => v === true, 'Dr. Patel');
    assert('the add writes milk only', items.map((row) => row.body),
      (v) => Array.isArray(v) && v.length === 1 && v[0] === 'milk', 'milk');
    assert('the surviving focus does not write a visit', visits.length === 1 && !/patel/i.test(speechOf(added)),
      (v) => v === true, 'no extra visit and no doctor in the add speech');
  }

  {
    const w = await world();
    w.medication.establish(['med_a', 'med_b']);
    w.ordered.establish('grocery', ['item_a', 'item_b']);
    const ordinal = await say(w, 'the second one');
    assert('coexisting medication and grocery sets clarify', speechOf(ordinal) === ORDERED_PRESENTATION_CONFUSION,
      (v) => v === true, ORDERED_PRESENTATION_CONFUSION);
    assert('clarify does not erase either set', w.medication.hasLive() && w.ordered.hasLive(),
      (v) => v === true, 'both live');
  }

  {
    const w = await world();
    w.db.prepare(`INSERT INTO lists (id, name, created_at) VALUES ('lg', 'grocery', '2026-09-01T15:00:00.000Z')`).run();
    w.db.prepare(`INSERT INTO list_items (id, list_id, body, checked, removed_at, created_at) VALUES ('item_a', 'lg', 'apples', 0, NULL, '2026-09-01T15:00:00.000Z')`).run();
    w.db.prepare(`INSERT INTO list_items (id, list_id, body, checked, removed_at, created_at) VALUES ('item_b', 'lg', 'bananas', 0, NULL, '2026-09-01T15:00:01.000Z')`).run();
    w.ordered.establish('grocery', ['item_a', 'item_b']);
    const ordinal = await say(w, 'the second one');
    assert('one grocery set resolves the second item', speechOf(ordinal).toLowerCase().includes('bananas'),
      (v) => v === true, 'bananas');
  }

  {
    const w = await world();
    w.db.prepare(
      `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
       VALUES ('med_metoprolol', 'metoprolol', '50mg', 'daily', 1, '2026-09-01T15:00:00.000Z', NULL),
              ('med_lisinopril', 'lisinopril', '50mg', 'daily', 1, '2026-09-01T15:00:01.000Z', NULL)`,
    ).run();
    w.db.prepare(`INSERT INTO lists (id, name, created_at) VALUES ('lg', 'grocery', '2026-09-01T15:00:00.000Z')`).run();
    w.db.prepare(`INSERT INTO list_items (id, list_id, body, checked, removed_at, created_at) VALUES ('item_a', 'lg', 'apples', 0, NULL, '2026-09-01T15:00:00.000Z')`).run();
    w.db.prepare(`INSERT INTO list_items (id, list_id, body, checked, removed_at, created_at) VALUES ('item_b', 'lg', 'bananas', 0, NULL, '2026-09-01T15:00:01.000Z')`).run();
    await say(w, 'What medications am I taking?');
    await say(w, "What's on my grocery list?");
    assert('the grocery presentation does not erase the medication set', w.medication.hasLive() && w.ordered.hasLive(),
      (v) => v === true, 'both live');
    const ordinal = await say(w, 'the second one');
    assert('the later grocery set does not silently win the ordinal', speechOf(ordinal) === ORDERED_PRESENTATION_CONFUSION,
      (v) => v === true, ORDERED_PRESENTATION_CONFUSION);
  }

  {
    const w = await world();
    w.calendar.establish(['evt_a', 'evt_b']);
    w.todo.establish(['todo_a', 'todo_b']);
    const ordinal = await say(w, 'the second one');
    assert('calendar and to-do through the utterance seam clarify', speechOf(ordinal) === ORDERED_PRESENTATION_CONFUSION,
      (v) => v === true, ORDERED_PRESENTATION_CONFUSION);
    assert('that clarify leaves both non-grocery sets live', w.calendar.hasLive() && w.todo.hasLive(),
      (v) => v === true, 'both live');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ConversationOrchestratorSlice1: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('conversationOrchestratorSlice1');
if (invokedDirectly) {
  runConversationOrchestratorSlice1Tests()
    .then((result) => process.exit(result.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
