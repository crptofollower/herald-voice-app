// Routed Operation Effect Contract V1.
// Metadata only. Does not change pending lifecycle, dispatch, or writers.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { routeIntent, type RouteDecision } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import {
  ACTION_INTENT_EFFECT,
  CAPTURE_INTENT_EFFECT,
  classifyRoutedEffect,
  mayPreserveExistingClarification,
  DEVICE_READ_PENDING_ARMING_REASONS,
  NEEDS_CLARIFICATION_PENDING_ARMING_REASONS,
  type RoutedEffectClass,
} from '../../src/routing/routedOperationEffect.ts';
import {
  CLARIFY_LIST_ADD_ITEM_KEY,
  CLARIFY_OPERATIONAL_LIST_KEY,
  UNRESOLVED_LIST_REFERENT_REASON,
} from '../../src/routing/operationalListContinuity.ts';
import { UNRESOLVED_LIST_ADD_SUPERSESSION_REASON } from '../../src/routing/sameUtteranceListAddRepair.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DUMMY_PENDING: Extract<RouteDecision, { kind: 'phone_repair_needed' }>['pending'] = {
  status: 'pending',
  prompt: 'x',
  pendingKey: 'x',
  resume: async () => ({ status: 'noop', ack: '' }),
};

function groceryCount(db: { prepare: (s: string) => { all: () => unknown[] } }): number {
  try {
    return db.prepare(
      `SELECT li.id FROM list_items li JOIN lists l ON l.id = li.list_id
       WHERE l.name = 'grocery' AND li.checked = 0 AND li.removed_at IS NULL`,
    ).all().length;
  } catch {
    return 0;
  }
}

export async function runRoutedOperationEffectContractV1Tests() {
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Routed Operation Effect Contract V1 --------------------${RESET}\n`);

  async function route(text: string, extra?: Partial<Parameters<typeof routeIntent>[1]>) {
    const { deps } = openJourneyDb();
    return routeIntent(normalizeInput(text), { ...deps, ...extra });
  }

  // Exhaustive closed maps
  assert(
    'ACTION_INTENT_EFFECT has 27 closed action types',
    Object.keys(ACTION_INTENT_EFFECT).length,
    (v) => v === 27,
    '27',
  );
  assert(
    'CAPTURE_INTENT_EFFECT has 16 closed intent types',
    Object.keys(CAPTURE_INTENT_EFFECT).length,
    (v) => v === 16,
    '16',
  );
  assert(
    'device_read pending-arming reasons are the fail-closed list pair',
    [...DEVICE_READ_PENDING_ARMING_REASONS],
    (v) => JSON.stringify(v) === JSON.stringify([
      UNRESOLVED_LIST_REFERENT_REASON,
      UNRESOLVED_LIST_ADD_SUPERSESSION_REASON,
    ]),
    'unresolved_list_referent + unresolved_list_add_supersession',
  );
  assert(
    'needs_clarification pending-arming reason is operational-list',
    [...NEEDS_CLARIFICATION_PENDING_ARMING_REASONS],
    (v) => JSON.stringify(v) === JSON.stringify(['ambiguous_operational_list']),
    'ambiguous_operational_list',
  );

  const timeA = await route('what time is it');
  const timeB = await route("what's the time");
  assert('time is device_action', timeA.kind, (v) => v === 'device_action', 'device_action');
  assert('time effect is read_only', timeA.effect, (v) => v === 'read_only', 'read_only');
  assert('time mayPreserveExistingClarification', mayPreserveExistingClarification(timeA), (v) => v === true, 'true');
  assert(
    'alternate time wording same effect',
    { a: timeA.effect, b: timeB.effect, ak: timeA.kind, bk: timeB.kind },
    (v) => {
      const o = v as { a: string; b: string; ak: string; bk: string };
      return o.a === 'read_only' && o.b === 'read_only' && o.ak === o.bk;
    },
    'both read_only same kind',
  );

  const dateD = await route("what's the date");
  assert('date effect is read_only', dateD.effect, (v) => v === 'read_only', 'read_only');

  const groceryReadA = await route("what's on my grocery list");
  const groceryReadB = await route('read my grocery list');
  assert('grocery list read is device_read', groceryReadA.kind, (v) => v === 'device_read', 'device_read');
  assert('grocery list read effect is read_only', groceryReadA.effect, (v) => v === 'read_only', 'read_only');
  assert(
    'alternate grocery-read wording same effect',
    { a: groceryReadA.effect, b: groceryReadB.effect },
    (v) => (v as { a: string; b: string }).a === 'read_only' && (v as { a: string; b: string }).b === 'read_only',
    'both read_only',
  );

  const todoRead = await route("what's on my to-do list");
  assert('todo read effect is read_only', todoRead.effect, (v) => v === 'read_only', 'read_only');

  const familyRead = await route("what's my wife's name");
  assert('family read is device_read', familyRead.kind, (v) => v === 'device_read', 'device_read');
  assert('family read effect is read_only', familyRead.effect, (v) => v === 'read_only', 'read_only');

  const medicalRead = await route('what medication am I on');
  assert('medical read effect is read_only', medicalRead.effect, (v) => v === 'read_only', 'read_only');

  const groceryAdd = await route('add bread to my grocery list');
  assert('ordinary grocery add is capture', groceryAdd.kind, (v) => v === 'capture', 'capture');
  assert('ordinary grocery add is mutating', groceryAdd.effect, (v) => v === 'mutating', 'mutating');
  assert('mutating mayPreserve is false', mayPreserveExistingClarification(groceryAdd), (v) => v === false, 'false');

  const todoAdd = await route('add buy stamps to my todo list');
  assert('ordinary todo add is capture', todoAdd.kind, (v) => v === 'capture', 'capture');
  assert('ordinary todo add is mutating', todoAdd.effect, (v) => v === 'mutating', 'mutating');

  const timer = await route('set a timer for 5 minutes');
  assert('timer is external_effect', timer.effect, (v) => v === 'external_effect', 'external_effect');

  const callD = await route('call Mom');
  assert('call is external_effect', callD.effect, (v) => v === 'external_effect', 'external_effect');

  const smsD = await route('text John hello');
  assert('sms is external_effect', smsD.effect, (v) => v === 'external_effect', 'external_effect');

  const nav = await route('navigate to the pharmacy');
  assert('navigation is not read_only', nav.effect, (v) => v !== 'read_only', 'not read_only');
  assert('navigation is external_effect', nav.effect, (v) => v === 'external_effect', 'external_effect');

  {
    const { db, deps } = openJourneyDb();
    const before = groceryCount(db as never);
    const those = await routeIntent(normalizeInput('add those to my grocery list'), deps);
    const after = groceryCount(db as never);
    assert('unresolved list referent is device_read', those.kind, (v) => v === 'device_read', 'device_read');
    assert(
      'unresolved list referent reason',
      those.kind === 'device_read' ? those.reason : null,
      (v) => v === UNRESOLVED_LIST_REFERENT_REASON,
      UNRESOLVED_LIST_REFERENT_REASON,
    );
    assert('unresolved list referent is pending_arming', those.effect, (v) => v === 'pending_arming', 'pending_arming');
    assert('unresolved list referent is not read_only', mayPreserveExistingClarification(those), (v) => v === false, 'false');
    assert('unresolved list referent wrote zero grocery rows', after - before, (v) => v === 0, '0');
  }

  {
    const superD = await route('add milk and bread to my grocery list, actually oat milk');
    assert(
      'unresolved list supersession is pending_arming',
      { kind: superD.kind, effect: superD.effect, reason: 'reason' in superD ? superD.reason : null },
      (v) => {
        const o = v as { kind: string; effect: string; reason: string | null };
        return o.effect === 'pending_arming' && o.reason === UNRESOLVED_LIST_ADD_SUPERSESSION_REASON;
      },
      'pending_arming + unresolved_list_add_supersession',
    );
  }

  assert(
    'medical_read_pending kind is pending_arming',
    classifyRoutedEffect({
      kind: 'medical_read_pending',
      pending: DUMMY_PENDING,
      reason: 'medical:visit_outcome_multiple_doctors',
    }),
    (v) => v === 'pending_arming',
    'pending_arming',
  );
  assert(
    'phone_repair_needed kind is pending_arming',
    classifyRoutedEffect({
      kind: 'phone_repair_needed',
      pending: DUMMY_PENDING,
      reason: 'deterministic:phone_repair',
    }),
    (v) => v === 'pending_arming',
    'pending_arming',
  );

  {
    const op = await route('grab milk and eggs');
    assert('operational-list route is needs_clarification', op.kind, (v) => v === 'needs_clarification', 'needs_clarification');
    assert('operational-list arm is pending_arming', op.effect, (v) => v === 'pending_arming', 'pending_arming');
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const out = await processUtterance(
      normalizeInput('add those to my grocery list'),
      session,
      deps,
      null, null, null, null, null, discourse,
    );
    assert(
      'list-add-item clarification arms pending',
      { key: session.peekPendingKey(), handled: out.handled, n: groceryCount(db as never) },
      (v) => {
        const o = v as { key: string | null; handled: boolean; n: number };
        return o.key === CLARIFY_LIST_ADD_ITEM_KEY && o.handled === false && o.n === 0;
      },
      'clarify:list_add_item + unhandled device_read + zero rows',
    );
    const routed = await routeIntent(normalizeInput('add those to my grocery list'), deps);
    assert('list-add-item arm route effect is pending_arming', routed.effect, (v) => v === 'pending_arming', 'pending_arming');
  }

  {
    const llmCap = await route('please remember the milk', {
      llmReady: true,
      grocerySemanticDecompositionEnabled: false,
      semanticCapabilityDispatchEnabled: false,
      capabilityReadRouterEnabled: false,
      medicationSemanticInterpretationEnabled: false,
      naturalMultiFactInterpretationEnabled: false,
      classifyLLM: async () => ({
        status: 'ok' as const,
        intents: [{ type: 'list_add' as const, items: ['milk'], listName: 'grocery' }],
      }),
    });
    assert('llm capture source is llm', llmCap.kind === 'capture' ? llmCap.source : null, (v) => v === 'llm', 'llm');
    assert('llm confirmation-arm capture is pending_arming', llmCap.effect, (v) => v === 'pending_arming', 'pending_arming');
  }

  assert(
    'effect independent of utterance text after routing',
    classifyRoutedEffect({
      kind: 'device_read',
      tier: 1,
      response: 'alpha',
      reason: 'family:read',
    }) === classifyRoutedEffect({
      kind: 'device_read',
      tier: 1,
      response: 'beta',
      reason: 'family:read',
    }),
    (v) => v === true,
    'same effect',
  );

  const kindMatrix: Array<[RouteDecision, RoutedEffectClass]> = [
    [{ kind: 'device_read', tier: 1, response: '', reason: 'family:read' }, 'read_only'],
    [{ kind: 'device_action', tier: 1, actionIntent: { type: 'timer', minutes: 1, label: 't' }, reason: 'action:timer' }, 'external_effect'],
    [{ kind: 'capture', intents: [{ type: 'list_add', items: ['x'], listName: 'grocery' }], source: 'deterministic', reason: 'tier1:list_todo_intercept' }, 'mutating'],
    [{ kind: 'interpretation_hold', reason: 'natural_multi_fact_v1', episodeId: 'e', candidates: [] }, 'competing_write'],
    [{ kind: 'phone_repair_needed', pending: DUMMY_PENDING, reason: 'deterministic:phone_repair' }, 'pending_arming'],
    [{ kind: 'medical_read_pending', pending: DUMMY_PENDING, reason: 'medical:visit_outcome_multiple_doctors' }, 'pending_arming'],
    [{ kind: 'not_ready', reason: 'llm:not_ready:loading' }, 'competing_write'],
    [{ kind: 'memory_probe', tier: 2, context: { intent: 'memory_probe' }, reason: 'tier2' }, 'competing_write'],
    [{ kind: 'backend', tier: 3, reason: 'live:data' }, 'external_effect'],
    [{ kind: 'needs_clarification', reason: 'default' }, 'competing_write'],
    [{ kind: 'needs_clarification', reason: 'ambiguous_operational_list' }, 'pending_arming'],
  ];
  for (const [decision, expected] of kindMatrix) {
    assert(
      `kind ${decision.kind}${decision.kind === 'needs_clarification' ? `:${decision.reason}` : ''} → ${expected}`,
      classifyRoutedEffect(decision),
      (v) => v === expected,
      expected,
    );
  }

  assert(
    'list_remove device_action is competing_write',
    classifyRoutedEffect({
      kind: 'device_action',
      tier: 1,
      actionIntent: { type: 'list_remove', item: 'milk', listName: 'grocery' },
      reason: 'action:list_remove',
    }),
    (v) => v === 'competing_write',
    'competing_write',
  );

  const puSrc = fs.readFileSync(path.join(__dirname, '../../src/routing/processUtterance.ts'), 'utf8');
  assert(
    'processUtterance consumes only mayPreserveExistingClarification',
    {
      module: puSrc.includes("from './routedOperationEffect'"),
      preserve: puSrc.includes('mayPreserveExistingClarification'),
      classify: puSrc.includes('classifyRoutedEffect') || puSrc.includes('ACTION_INTENT_EFFECT'),
    },
    (v) => {
      const o = v as { module: boolean; preserve: boolean; classify: boolean };
      return o.module && o.preserve && !o.classify;
    },
    'mayPreserve import only',
  );
  assert(
    'clarification yield still keys off actionIntent (lifecycle unchanged)',
    /yieldClarification = isClarificationPendingKey\(pendingKey\)[\s\S]*!!decision\.actionIntent/.test(puSrc),
    (v) => v === true,
    'actionIntent yield still present',
  );

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const arm = await processUtterance(
      normalizeInput('grab milk and eggs'),
      session,
      deps,
      null, null, null, null, null, discourse,
    );
    const keyBefore = session.peekPendingKey();
    const nBefore = groceryCount(db as never);
    const interrupt = await processUtterance(
      normalizeInput('what time is it'),
      session,
      deps,
      null, null, null, null, null, discourse,
    );
    assert(
      'read_only time interruption preserves operational clarification (survival)',
      {
        armed: arm.handled && keyBefore === CLARIFY_OPERATIONAL_LIST_KEY,
        after: session.peekPendingKey(),
        interruptKind: !interrupt.handled ? interrupt.routeDecision.kind : null,
        effect: !interrupt.handled && 'effect' in interrupt.routeDecision
          ? (interrupt.routeDecision as RouteDecision & { effect?: string }).effect
          : null,
        rows: groceryCount(db as never) - nBefore,
      },
      (v) => {
        const o = v as {
          armed: boolean;
          after: string | null;
          interruptKind: string | null;
          effect: string | null;
          rows: number;
        };
        return o.armed && o.after === CLARIFY_OPERATIONAL_LIST_KEY && o.interruptKind === 'device_action' && o.effect === 'read_only' && o.rows === 0;
      },
      'armed, pending kept, time device_action read_only, zero writes',
    );
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('routedOperationEffect.test.ts')) {
  runRoutedOperationEffectContractV1Tests().then((r) => {
    console.log(`\n${r.failed ? RED : GREEN}${r.passed} passed / ${r.failed} failed / ${r.total} total${RESET}\n`);
    process.exit(r.failed ? 1 : 0);
  });
}
