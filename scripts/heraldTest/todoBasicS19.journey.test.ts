// Scenario 19 — todo.basic.s19
// Capture → authoritative todo_read → deterministic todo_complete match →
// confirm → completed state → reread. Production seam only.

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

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const JOURNEY_ID = 'todo.basic.s19';
const TURNS = [
  'I need to call the dentist.',
  'What do I need to do?',
  'I called the dentist.',
  'Yes',
  'What do I need to do?',
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

function openTodos(items: ListItemRow[]): ListItemRow[] {
  return items.filter((i) => i.list_name === 'todos' && i.checked === 0 && !i.removed_at);
}

function dentistRows(items: ListItemRow[]): ListItemRow[] {
  return items.filter((i) => i.list_name === 'todos' && /call the dentist/i.test(i.body));
}

function gradeT1(t: TurnRecord): ContractResult[] {
  const items = t.db_after.list_items;
  const open = openTodos(items);
  const dentist = dentistRows(items);
  return [
    c('A.capture_authority', 'authoritative todo capture via shared capture seam',
      t.route_source === 'capture' && t.commit_statuses.includes('committed'),
      `source=${t.route_source} commits=${JSON.stringify(t.commit_statuses)} reason=${t.route_reason}`),
    c('B.durable_persistence', 'one open durable dentist task',
      dentist.length === 1 && open.length === 1 && dentist[0].id.length > 0
        && /call the dentist/i.test(dentist[0].body) && dentist[0].checked === 0 && !dentist[0].removed_at,
      `items=${JSON.stringify(items)}`),
  ];
}

function gradeT2(t: TurnRecord): ContractResult[] {
  const text = t.response ?? '';
  const wrote = t.db_diff.list_items_added.length
    + t.db_diff.list_items_removed.length
    + t.db_diff.list_items_changed.length;
  return [
    c('C.authoritative_read', 'shared todo_read device_read seam',
      t.route_kind === 'device_read' && t.route_reason === 'action:todo_read',
      `kind=${t.route_kind} reason=${t.route_reason}`),
    c('D.read_matches_state', 'read presents stored dentist task only',
      /call the dentist/i.test(text) && /You've got 1 open:/i.test(text)
        && !/fabricat|unknown task/i.test(text),
      `response=${JSON.stringify(text)}`),
    c('T2.no_write', 'todo_read does not mutate list_items',
      wrote === 0,
      `diff_ops=${wrote}`),
  ];
}

function gradeT3(t: TurnRecord): ContractResult[] {
  const dentist = dentistRows(t.db_after.list_items);
  const mutated = t.db_diff.list_items_changed.length + t.db_diff.list_items_removed.length;
  return [
    c('E.completion_authority', 'todo_complete match arms existing todo_add.remove pending',
      t.route_source === 'capture'
        && t.pending_after === true
        && t.pending_key_after === 'todo_complete'
        && t.commit_pending_keys.includes('todo_complete'),
      `source=${t.route_source} pending=${t.pending_key_after} commits=${JSON.stringify(t.commit_pending_keys)}`),
    c('T3.no_mutation_yet', 'Yes not spoken — open item unchanged',
      mutated === 0 && dentist.length === 1 && dentist[0].checked === 0 && !dentist[0].removed_at,
      `changed=${t.db_diff.list_items_changed.length} dentist=${JSON.stringify(dentist)}`),
  ];
}

function gradeT4(t: TurnRecord, captureId: string | null): ContractResult[] {
  const dentist = dentistRows(t.db_after.list_items);
  const open = openTodos(t.db_after.list_items);
  const sameId = captureId != null && dentist.length === 1 && dentist[0].id === captureId;
  return [
    c('F.identity_preserved', 'same durable item id survives capture→completion',
      sameId && t.db_after.list_items.length === 1,
      `captureId=${captureId} after=${JSON.stringify(dentist)} count=${t.db_after.list_items.length}`),
    c('G.completed_state', 'checked=1 and removed_at populated',
      dentist.length === 1 && dentist[0].checked === 1 && !!dentist[0].removed_at,
      `dentist=${JSON.stringify(dentist)}`),
    c('T4.confirm_commit', 'Yes resumes todo_complete pending',
      t.route_source === 'pending_resume' && t.pending_key_before === 'todo_complete'
        && t.pending_after === false && open.length === 0,
      `source=${t.route_source} pending_before=${t.pending_key_before} open=${open.length}`),
  ];
}

function gradeT5(t: TurnRecord): ContractResult[] {
  const text = t.response ?? '';
  const open = openTodos(t.db_after.list_items);
  return [
    c('H.reread_respects_completion', 'completed dentist task is not presented as open',
      t.route_kind === 'device_read' && t.route_reason === 'action:todo_read'
        && /You're all clear — nothing on your to-do list\./.test(text)
        && !/call the dentist/i.test(text)
        && open.length === 0,
      `kind=${t.route_kind} reason=${t.route_reason} open=${open.length} response=${JSON.stringify(text)}`),
  ];
}

export async function runTodoBasicS19Journey(): Promise<{ packet: JourneyPacket; artifactPath: string }> {
  const git = captureGitMeta(process.cwd());
  const { db, session, deps } = openJourneyDb();
  const turns: TurnRecord[] = [];
  for (let i = 0; i < TURNS.length; i++) {
    const rec = await runJourneyTurn(db, session, deps, i + 1, TURNS[i]);
    const gradeable = requiredTurnEvidencePresent(rec);
    const captureId = dentistRows(turns[0]?.db_after.list_items ?? rec.db_after.list_items)[0]?.id ?? null;
    const graders = [
      gradeT1,
      gradeT2,
      gradeT3,
      (t: TurnRecord) => gradeT4(t, captureId),
      gradeT5,
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

  const evidenceOk = turns.every((t) => requiredTurnEvidencePresent(t))
    && turns[0].db_after.list_items[0]?.id
    && turns[3].db_after.list_items[0]?.id === turns[0].db_after.list_items[0]?.id;
  const journeyContracts: ContractResult[] = [
    c('I.evidence_sufficient', 'harness exposes durable list identity/state',
      evidenceOk,
      `t1=${JSON.stringify(turns[0]?.db_after.list_items)} t4=${JSON.stringify(turns[3]?.db_after.list_items)}`),
  ];
  const harnessFail = turns.some((t) => t.result === 'NOT_GRADEABLE') || !evidenceOk;
  const productFail = turns.some((t) => t.result === 'FAIL') || journeyContracts.some((x) => x.verdict === 'FAIL');
  const overall: ContractVerdict = harnessFail ? 'NOT_GRADEABLE' : productFail ? 'FAIL' : 'PASS';
  const firstFail = turns.find((t) => t.result !== 'PASS');
  const packet: JourneyPacket = {
    schema_version: JOURNEY_SCHEMA_VERSION,
    journey_id: JOURNEY_ID,
    run_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    git,
    seed: 'empty lists/list_items; llmReady=false',
    production_seam: 'normalizeInput → processUtterance → ConversationSession + DOMAIN_WRITERS via applyIntents; classifyQuery live; classifyLLM stub empty; setDB better-sqlite3; todo_read via routeIntent device_read; todo_complete match via DOMAIN_WRITERS.todo_complete.add → DOMAIN_WRITERS.todo_add.remove',
    contracts: [
      'A capture_authority',
      'B durable_persistence',
      'C authoritative_read',
      'D read_matches_state',
      'E completion_authority',
      'F identity_preserved',
      'G completed_state',
      'H reread_respects_completion',
      'I evidence_sufficient',
    ],
    turns,
    overall,
    first_material_divergence: firstFail
      ? `T${firstFail.turn} ${firstFail.result}: ${firstFail.contracts.filter((x) => x.verdict !== 'PASS').map((x) => x.id).join(', ') || 'missing evidence'}`
      : (!evidenceOk ? 'I.evidence_sufficient' : null),
    failure_class: harnessFail ? 'HARNESS_FAIL' : productFail ? 'PRODUCT_FAIL' : 'none',
  };
  const artifactPath = writeJourneyPacket(packet, `${JOURNEY_ID}.json`);
  return { packet, artifactPath };
}

export async function runTodoBasicS19Tests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- To-do Journey S19 (todo.basic.s19) --${RESET}\n`);

  const { packet, artifactPath } = await runTodoBasicS19Journey();
  console.log(`  evidence: ${artifactPath}`);
  console.log(`  overall: ${packet.overall}  failure_class=${packet.failure_class}`);
  for (const t of packet.turns) {
    console.log(`  T${t.turn} ${t.result}  in=${JSON.stringify(t.input)}  owner=${t.route_owner} reason=${t.route_reason}`);
    console.log(`       response=${JSON.stringify(t.response)}`);
    console.log(`       list_items=${JSON.stringify(t.db_after.list_items)}`);
  }

  const t1 = packet.turns[0];
  const t3 = packet.turns[2];
  const t4 = packet.turns[3];
  const t5 = packet.turns[4];
  const captureId = t1?.db_after.list_items[0]?.id ?? null;

  check('S19 packet schema_version', packet.schema_version === JOURNEY_SCHEMA_VERSION);
  check('S19 packet journey_id', packet.journey_id === JOURNEY_ID);
  check('S19 five turns recorded', packet.turns.length === 5);
  check('S19 every turn has exact response (gradeable)',
    packet.turns.every((t) => requiredTurnEvidencePresent(t)));
  check('S19 not HARNESS_FAIL', packet.failure_class !== 'HARNESS_FAIL');
  check('S19 T1 capture+durable item', t1?.result === 'PASS');
  check('S19 T2 authoritative todo_read', packet.turns[1]?.result === 'PASS');
  check('S19 T3 complete pending no mutation', t3?.result === 'PASS');
  check('S19 T4 Yes completes same id', t4?.result === 'PASS');
  check('S19 T5 reread excludes completed item', t5?.result === 'PASS');
  check('S19 overall PASS', packet.overall === 'PASS');
  check('S19 A capture_authority', t1?.contracts.find((x) => x.id === 'A.capture_authority')?.verdict === 'PASS');
  check('S19 B durable_persistence', t1?.contracts.find((x) => x.id === 'B.durable_persistence')?.verdict === 'PASS');
  check('S19 C authoritative_read', packet.turns[1]?.contracts.find((x) => x.id === 'C.authoritative_read')?.verdict === 'PASS');
  check('S19 D read_matches_state', packet.turns[1]?.contracts.find((x) => x.id === 'D.read_matches_state')?.verdict === 'PASS');
  check('S19 E completion_authority', t3?.contracts.find((x) => x.id === 'E.completion_authority')?.verdict === 'PASS');
  check('S19 F identity_preserved', t4?.contracts.find((x) => x.id === 'F.identity_preserved')?.verdict === 'PASS');
  check('S19 G completed_state', t4?.contracts.find((x) => x.id === 'G.completed_state')?.verdict === 'PASS');
  check('S19 H reread_respects_completion', t5?.contracts.find((x) => x.id === 'H.reread_respects_completion')?.verdict === 'PASS');
  check('S19 I evidence_sufficient',
    requiredTurnEvidencePresent(t1) && captureId != null
      && t4?.db_after.list_items[0]?.id === captureId
      && t4?.db_after.list_items[0]?.checked === 1
      && !!t4?.db_after.list_items[0]?.removed_at);

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`${RED}❌ todo.basic.s19: ${failures.length} failed${RESET}`);
  } else {
    console.log(`${GREEN}✅ todo.basic.s19: ${passed}/${total} — all green${RESET}`);
  }
  return { passed, failed: failures.length, total, packet, artifactPath };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('todoBasicS19.journey.test.ts')) {
  runTodoBasicS19Tests().catch(console.error);
}
