// Scenario 20 — grocery.basic.s20
// Capture → shared grocery list_read + OPR grant → live OPR read → named OPR mutation → reread.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureGitMeta,
  openJourneyDb,
  requiredTurnEvidencePresent,
  runJourneyTurn,
  writeJourneyPacket,
  JOURNEY_SCHEMA_VERSION,
  type ContractResult,
  type ContractVerdict,
  type JourneyPacket,
  type ListItemRow,
  type TurnRecord,
} from './journeyHarness.ts';
import { getPresentedOpenListItems } from '../../src/db/listRead.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const JOURNEY_ID = 'grocery.basic.s20';
const TURNS = [
  'I need eggs and milk.',
  "What's on my grocery list?",
  'the first one',
  'Remove the second thing from my grocery list.',
  "What's on my grocery list?",
] as const;

function c(id: string, description: string, ok: boolean, evidence: string): ContractResult {
  return { id, description, verdict: ok ? 'PASS' : 'FAIL', evidence };
}

function rollTurn(contracts: ContractResult[], gradeable: boolean): ContractVerdict {
  if (!gradeable) return 'NOT_GRADEABLE';
  if (contracts.some((x) => x.verdict === 'FAIL')) return 'FAIL';
  if (contracts.every((x) => x.verdict === 'PASS')) return 'PASS';
  return 'NOT_GRADEABLE';
}

function openGrocery(items: ListItemRow[]): ListItemRow[] {
  return items.filter((i) => i.list_name === 'grocery' && i.checked === 0 && !i.removed_at);
}

function groceryEggs(items: ListItemRow[]): ListItemRow | undefined {
  return items.find((i) => i.list_name === 'grocery' && /^eggs$/i.test(i.body));
}

function groceryMilk(items: ListItemRow[]): ListItemRow | undefined {
  // Production list_add keeps the utterance period on the last item ("milk.").
  return items.find((i) => i.list_name === 'grocery' && /^milk\.?$/i.test(i.body));
}

function gradeT1(t: TurnRecord): ContractResult[] {
  const open = openGrocery(t.db_after.list_items);
  const eggs = groceryEggs(t.db_after.list_items);
  const milk = groceryMilk(t.db_after.list_items);
  return [
    c('A.capture_authority', 'grocery capture via shared list_add writer',
      t.route_source === 'capture' && t.commit_statuses.includes('committed'),
      `source=${t.route_source} commits=${JSON.stringify(t.commit_statuses)}`),
    c('B.durable_persistence', 'eggs and milk open on grocery',
      open.length === 2 && !!eggs && !!milk && eggs.checked === 0 && milk.checked === 0,
      `open=${JSON.stringify(open)}`),
  ];
}

function gradeT2(t: TurnRecord): ContractResult[] {
  const presented = getPresentedOpenListItems('grocery');
  const ids = presented.map((i) => i.id);
  const text = t.response ?? '';
  const wrote = t.db_diff.list_items_added.length
    + t.db_diff.list_items_changed.length
    + t.db_diff.list_items_removed.length;
  const holder = t.opr_presented_ids ?? [];
  return [
    c('C.authoritative_read', 'shared grocery list_read device_read',
      t.route_kind === 'device_read' && t.route_reason === 'action:list_read',
      `kind=${t.route_kind} reason=${t.route_reason}`),
    c('D.read_matches_state', 'speech names eggs and milk; both remain presented',
      /eggs/i.test(text) && /milk/i.test(text) && presented.length === 2
        && presented.some((i) => /eggs/i.test(i.body))
        && presented.some((i) => /milk/i.test(i.body)),
      `response=${JSON.stringify(text)} presented=${JSON.stringify(presented)}`),
    c('E.presentation_grant', 'OPR holder IDs equal presented durable IDs from the same read order',
      JSON.stringify(holder) === JSON.stringify(ids) && ids.length === 2,
      `holder=${JSON.stringify(holder)} presented=${JSON.stringify(ids)}`),
    c('T2.no_write', 'list_read does not mutate',
      wrote === 0,
      `diff_ops=${wrote}`),
  ];
}

function gradeT3(t: TurnRecord, firstPresentedId: string | undefined): ContractResult[] {
  const wrote = t.db_diff.list_items_changed.length + t.db_diff.list_items_removed.length;
  const text = t.response ?? '';
  const first = t.db_after.list_items.find((i) => i.id === firstPresentedId);
  const expected = first ? `That's ${first.body}.` : '';
  return [
    c('F.positional_reference', 'live OPR first-one read-back',
      t.route_source === 'referent_resume' && text === expected && !!first,
      `source=${t.route_source} response=${JSON.stringify(text)} expected=${JSON.stringify(expected)}`),
    c('G.stable_identity', 'first presented id is unchanged and still open',
      !!firstPresentedId && t.opr_presented_ids?.[0] === firstPresentedId
        && !!first && first.checked === 0,
      `firstId=${firstPresentedId} holder=${JSON.stringify(t.opr_presented_ids)}`),
    c('T3.no_mutation', 'OPR read does not write',
      wrote === 0,
      `changed=${t.db_diff.list_items_changed.length}`),
  ];
}

function gradeT4(t: TurnRecord, milkId: string | undefined, eggsId: string | undefined): ContractResult[] {
  const milk = milkId ? t.db_after.list_items.find((i) => i.id === milkId) : undefined;
  const eggs = eggsId ? t.db_after.list_items.find((i) => i.id === eggsId) : undefined;
  const open = openGrocery(t.db_after.list_items);
  const text = t.response ?? '';
  return [
    c('H.mutation_authority', 'named OPR mutation handled on shared seam',
      t.route_source === 'referent_resume' && /^Done — milk\.? is off/i.test(text),
      `source=${t.route_source} response=${JSON.stringify(text)}`),
    c('I.mutation_matches_reference', 'second item milk completed; eggs remains open',
      !!milk && milk.checked === 1 && !!milk.removed_at
        && !!eggs && eggs.checked === 0 && open.length === 1 && open[0].id === eggsId,
      `milk=${JSON.stringify(milk)} eggs=${JSON.stringify(eggs)} open=${open.length}`),
    c('T4.holder_fresh', 'holder is remaining presentation only',
      JSON.stringify(t.opr_presented_ids) === JSON.stringify(getPresentedOpenListItems('grocery').map((i) => i.id)),
      `holder=${JSON.stringify(t.opr_presented_ids)} presented=${JSON.stringify(getPresentedOpenListItems('grocery'))}`),
  ];
}

function gradeT5(t: TurnRecord, milkId: string | undefined, eggsId: string | undefined): ContractResult[] {
  const open = openGrocery(t.db_after.list_items);
  const text = t.response ?? '';
  return [
    c('J.reread_respects_mutation', 'reread presents remaining eggs, not milk',
      t.route_kind === 'device_read' && t.route_reason === 'action:list_read'
        && /eggs/i.test(text) && !/milk/i.test(text)
        && open.length === 1 && open[0].id === eggsId
        && JSON.stringify(t.opr_presented_ids) === JSON.stringify(getPresentedOpenListItems('grocery').map((i) => i.id)),
      `response=${JSON.stringify(text)} open=${JSON.stringify(open)} holder=${JSON.stringify(t.opr_presented_ids)}`),
    c('T5.holder_matches_reread', 'fresh grant IDs match remaining presented open',
      JSON.stringify(t.opr_presented_ids) === JSON.stringify(getPresentedOpenListItems('grocery').map((i) => i.id)),
      `holder=${JSON.stringify(t.opr_presented_ids)}`),
    c('T5.milk_still_completed', 'milk durable row remains completed',
      !!milkId && t.db_after.list_items.find((i) => i.id === milkId)?.checked === 1,
      `milk=${JSON.stringify(t.db_after.list_items.find((i) => i.id === milkId))}`),
  ];
}

export async function runGroceryBasicS20Journey(): Promise<{ packet: JourneyPacket; artifactPath: string }> {
  const git = captureGitMeta(process.cwd());
  const { db, session, deps, orderedPresentation } = openJourneyDb();
  const turns: TurnRecord[] = [];
  for (let i = 0; i < TURNS.length; i++) {
    const rec = await runJourneyTurn(db, session, deps, i + 1, TURNS[i], orderedPresentation);
    const gradeable = requiredTurnEvidencePresent(rec);
    const t1Open = openGrocery(turns[0]?.db_after.list_items ?? rec.db_after.list_items);
    const eggsId = groceryEggs(t1Open)?.id ?? groceryEggs(rec.db_after.list_items)?.id;
    const milkId = groceryMilk(t1Open)?.id ?? groceryMilk(rec.db_after.list_items)?.id;
    const t2Holder = turns[1]?.opr_presented_ids ?? rec.opr_presented_ids;
    const firstPresentedId = t2Holder?.[0];
    const graders = [
      gradeT1,
      gradeT2,
      (t: TurnRecord) => gradeT3(t, firstPresentedId),
      (t: TurnRecord) => gradeT4(t, milkId, eggsId),
      (t: TurnRecord) => gradeT5(t, milkId, eggsId),
    ];
    rec.contracts = gradeable ? graders[i](rec) : [{
      id: `T${i + 1}.evidence`,
      description: 'required turn evidence present',
      verdict: 'NOT_GRADEABLE',
      evidence: `response=${JSON.stringify(rec.response)}`,
    }];
    rec.result = rollTurn(rec.contracts, gradeable);
    turns.push(rec);
  }

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dispatchSrc = fs.readFileSync(path.join(root, 'src/screens/chat/dispatch.ts'), 'utf8');
  const noListReadIsland = !/actionIntent\.type === 'list_read'/.test(dispatchSrc);
  const listRemoveUntouched = /actionIntent\.type === 'list_remove'/.test(dispatchSrc);
  const journeyContracts: ContractResult[] = [
    c('K.UI_ownership_repaired', 'ChatScreen dispatch has no list_read execution block',
      noListReadIsland,
      `list_read_block=${!noListReadIsland}`),
    c('M.regression_boundary', 'list_remove ChatScreen path remains',
      listRemoveUntouched,
      `list_remove_present=${listRemoveUntouched}`),
    c('L.frozen_OPR_semantics_preserved', 'T3 live first-one + T4 named second mutation',
      turns[2]?.result === 'PASS' && turns[3]?.result === 'PASS',
      `T3=${turns[2]?.result} T4=${turns[3]?.result}`),
    c('N.evidence_sufficient', 'responses, list rows, and OPR IDs present',
      turns.every((t) => requiredTurnEvidencePresent(t))
        && Array.isArray(turns[1]?.opr_presented_ids)
        && (turns[1]?.opr_presented_ids?.length ?? 0) === 2,
      `t2_holder=${JSON.stringify(turns[1]?.opr_presented_ids)}`),
  ];
  const harnessFail = turns.some((t) => t.result === 'NOT_GRADEABLE')
    || journeyContracts.some((x) => x.verdict === 'NOT_GRADEABLE');
  const productFail = turns.some((t) => t.result === 'FAIL')
    || journeyContracts.some((x) => x.verdict === 'FAIL');
  const overall: ContractVerdict = harnessFail ? 'NOT_GRADEABLE' : productFail ? 'FAIL' : 'PASS';
  const firstFail = [...turns.flatMap((t) => t.contracts), ...journeyContracts].find((x) => x.verdict !== 'PASS');
  const packet: JourneyPacket = {
    schema_version: JOURNEY_SCHEMA_VERSION,
    journey_id: JOURNEY_ID,
    run_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    git,
    seed: 'empty grocery lists; OrderedPresentationHolder live; llmReady=false',
    production_seam: 'normalizeInput → processUtterance(+OrderedPresentationHolder) → list_add writer; grocery list_read device_read + maybeEstablishGroceryPresentation; named OPR mutation markOpenListItemRemovedById',
    contracts: [
      'A capture_authority',
      'B durable_persistence',
      'C authoritative_read',
      'D read_matches_state',
      'E presentation_grant',
      'F positional_reference',
      'G stable_identity',
      'H mutation_authority',
      'I mutation_matches_reference',
      'J reread_respects_mutation',
      'K UI_ownership_repaired',
      'L frozen_OPR_semantics_preserved',
      'M regression_boundary',
      'N evidence_sufficient',
    ],
    turns,
    overall,
    first_material_divergence: firstFail
      ? `${firstFail.id} ${firstFail.verdict}: ${firstFail.evidence}`
      : null,
    failure_class: harnessFail ? 'HARNESS_FAIL' : productFail ? 'PRODUCT_FAIL' : 'none',
  };
  // Attach journey-level contracts onto T5 output by logging; packet.turns stay per-turn.
  // Persist them as extra evidence on the packet via first_material_divergence only.
  const extraOk = journeyContracts.every((x) => x.verdict === 'PASS');
  if (!extraOk && packet.overall === 'PASS') {
    packet.overall = 'FAIL';
    packet.failure_class = 'PRODUCT_FAIL';
  }
  packet.journey_contracts = journeyContracts;
  const artifactPath = writeJourneyPacket(packet, `${JOURNEY_ID}.json`);
  return { packet, artifactPath };
}

export async function runGroceryBasicS20Tests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- Grocery Journey S20 (grocery.basic.s20) --${RESET}\n`);

  const { packet, artifactPath } = await runGroceryBasicS20Journey();
  const extra = packet.journey_contracts ?? [];
  console.log(`  evidence: ${artifactPath}`);
  console.log(`  overall: ${packet.overall}  failure_class=${packet.failure_class}`);
  for (const t of packet.turns) {
    console.log(`  T${t.turn} ${t.result}  in=${JSON.stringify(t.input)}  owner=${t.route_owner} reason=${t.route_reason}`);
    console.log(`       response=${JSON.stringify(t.response)}`);
    console.log(`       opr=${JSON.stringify(t.opr_presented_ids)}`);
    console.log(`       list_items=${JSON.stringify(t.db_after.list_items)}`);
  }

  check('S20 packet schema_version', packet.schema_version === JOURNEY_SCHEMA_VERSION);
  check('S20 packet journey_id', packet.journey_id === JOURNEY_ID);
  check('S20 five turns recorded', packet.turns.length === 5);
  check('S20 every turn gradeable', packet.turns.every((t) => requiredTurnEvidencePresent(t)));
  check('S20 not HARNESS_FAIL', packet.failure_class !== 'HARNESS_FAIL');
  check('S20 T1 capture', packet.turns[0]?.result === 'PASS');
  check('S20 T2 shared read+grant', packet.turns[1]?.result === 'PASS');
  check('S20 T3 live OPR', packet.turns[2]?.result === 'PASS');
  check('S20 T4 named mutation', packet.turns[3]?.result === 'PASS');
  check('S20 T5 reread', packet.turns[4]?.result === 'PASS');
  check('S20 overall PASS', packet.overall === 'PASS');
  for (const id of ['A.capture_authority', 'B.durable_persistence']) {
    check(`S20 ${id}`, packet.turns[0]?.contracts.find((x) => x.id === id)?.verdict === 'PASS');
  }
  for (const id of ['C.authoritative_read', 'D.read_matches_state', 'E.presentation_grant']) {
    check(`S20 ${id}`, packet.turns[1]?.contracts.find((x) => x.id === id)?.verdict === 'PASS');
  }
  for (const id of ['F.positional_reference', 'G.stable_identity']) {
    check(`S20 ${id}`, packet.turns[2]?.contracts.find((x) => x.id === id)?.verdict === 'PASS');
  }
  for (const id of ['H.mutation_authority', 'I.mutation_matches_reference']) {
    check(`S20 ${id}`, packet.turns[3]?.contracts.find((x) => x.id === id)?.verdict === 'PASS');
  }
  check('S20 J.reread_respects_mutation',
    packet.turns[4]?.contracts.find((x) => x.id === 'J.reread_respects_mutation')?.verdict === 'PASS');
  for (const id of ['K.UI_ownership_repaired', 'L.frozen_OPR_semantics_preserved', 'M.regression_boundary', 'N.evidence_sufficient']) {
    check(`S20 ${id}`, extra.find((x) => x.id === id)?.verdict === 'PASS');
  }

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`${RED}❌ grocery.basic.s20: ${failures.length} failed${RESET}`);
  } else {
    console.log(`${GREEN}✅ grocery.basic.s20: ${passed}/${total} — all green${RESET}`);
  }
  return { passed, failed: failures.length, total, packet, artifactPath };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('groceryBasicS20.journey.test.ts')) {
  runGroceryBasicS20Tests().catch(console.error);
}
