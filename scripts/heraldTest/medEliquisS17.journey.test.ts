// Scenario 17 — med.eliquis.s17
// One process, one ConversationSession, one disposable medications DB.
// Production seam only. Does not repair product failures.

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
  type TurnRecord,
} from './journeyHarness.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const JOURNEY_ID = 'med.eliquis.s17';
const TURNS = [
  'I take Eliquis 5 mg twice a day.',
  'Yes.',
  'What medications am I taking?',
  'How often do I take Eliquis?',
  'What did I tell you about Eliquis?',
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

function gradeT1(t: TurnRecord): ContractResult[] {
  const noWrite = t.db_diff.added.length === 0 && t.db_diff.changed.length === 0
    && t.db_after.medications.length === 0;
  return [
    c('T1.capture', 'medication assertion owned as capture',
      t.route_source === 'capture' && t.route_reason === 'medical_capture',
      `owner=${t.route_owner} reason=${t.route_reason}`),
    c('T1.confirm_required', 'confirmation required (pending live)',
      t.pending_after === true && t.pending_key_after === 'medical_capture',
      `pending_after=${t.pending_after} key=${t.pending_key_after}`),
    c('T1.no_write', 'no medication DB write before confirmation',
      noWrite,
      `added=${t.db_diff.added.length} after_count=${t.db_after.medications.length}`),
  ];
}

function gradeT2(t: TurnRecord): ContractResult[] {
  const active = t.db_after.medications.filter((r) => r.is_active === 1);
  const eliquis = active.find((r) => r.name === 'Eliquis');
  const doseOk = !!eliquis && /5\s*mg/i.test(eliquis.dosage ?? '');
  const freqOk = eliquis?.frequency === 'twice a day';
  return [
    c('T2.pending_owns_yes', 'pending confirmation owns Yes',
      t.route_source === 'pending_resume' && t.pending_key_before === 'medical_capture',
      `source=${t.route_source} pending_before=${t.pending_key_before}`),
    c('T2.row_written', 'Eliquis row is written',
      !!eliquis && t.db_diff.added.length === 1,
      `active=${active.map((r) => r.name).join(',') || '(none)'} added=${t.db_diff.added.length}`),
    c('T2.dosage', 'dosage is the explicit stored dose',
      doseOk,
      `dosage=${eliquis?.dosage ?? 'null'}`),
    c('T2.frequency', 'frequency is the explicit stored frequency',
      freqOk,
      `frequency=${eliquis?.frequency ?? 'null'}`),
    c('T2.no_fabricate', 'no fabricated name/dose/frequency',
      !!eliquis && doseOk && freqOk && active.length === 1,
      `row=${JSON.stringify(eliquis ?? null)}`),
  ];
}

function gradeT3(t: TurnRecord): ContractResult[] {
  const wrote = t.db_diff.added.length + t.db_diff.removed.length + t.db_diff.changed.length;
  const text = t.response ?? '';
  return [
    c('T3.authoritative_read', 'authoritative medication list read',
      t.route_kind === 'device_read' && t.route_reason === 'medical:summary',
      `kind=${t.route_kind} reason=${t.route_reason}`),
    c('T3.eliquis_from_store', 'Eliquis appears from stored state',
      /Eliquis/i.test(text),
      `response=${JSON.stringify(text)}`),
    c('T3.no_write', 'list read does not write',
      wrote === 0,
      `diff_ops=${wrote}`),
  ];
}

function gradeT4(t: TurnRecord): ContractResult[] {
  const wrote = t.db_diff.added.length + t.db_diff.removed.length + t.db_diff.changed.length;
  const text = t.response ?? '';
  return [
    c('T4.inquiry_not_capture', 'frequency inquiry is a read, not capture',
      t.route_kind === 'device_read' && t.route_reason === 'medical:named_inquiry' && t.route_source !== 'capture',
      `kind=${t.route_kind} reason=${t.route_reason} source=${t.route_source}`),
    c('T4.stored_frequency', 'returns stored frequency',
      /twice a day/i.test(text) && /Eliquis/i.test(text),
      `response=${JSON.stringify(text)}`),
    c('T4.no_write', 'inquiry does not write',
      wrote === 0,
      `diff_ops=${wrote}`),
  ];
}

function gradeT5(t: TurnRecord): ContractResult[] {
  const wrote = t.db_diff.added.length + t.db_diff.removed.length + t.db_diff.changed.length;
  const text = t.response ?? '';
  const profileDump = /your name is/i.test(text) || /still learning about you/i.test(text)
    || t.route_reason === 'memory:probe' || t.route_kind === 'memory_probe';
  return [
    c('T5.named_retrieval', 'named medication retrieval owner',
      t.route_kind === 'device_read' && t.route_reason === 'medical:named_inquiry',
      `kind=${t.route_kind} reason=${t.route_reason}`),
    c('T5.stored_med', 'returns stored medication information',
      /Eliquis/i.test(text),
      `response=${JSON.stringify(text)}`),
    c('T5.not_profile', 'does not fall into generic profile recall',
      !profileDump,
      `reason=${t.route_reason} response=${JSON.stringify(text)}`),
    c('T5.no_write', 'named recall does not write',
      wrote === 0,
      `diff_ops=${wrote}`),
  ];
}

const GRADERS = [gradeT1, gradeT2, gradeT3, gradeT4, gradeT5];

export async function runMedEliquisS17Journey(): Promise<{ packet: JourneyPacket; artifactPath: string }> {
  const git = captureGitMeta(process.cwd());
  const { db, session, deps } = openJourneyDb();
  const turns: TurnRecord[] = [];
  for (let i = 0; i < TURNS.length; i++) {
    const rec = await runJourneyTurn(db, session, deps, i + 1, TURNS[i]);
    const gradeable = requiredTurnEvidencePresent(rec);
    rec.contracts = gradeable ? GRADERS[i](rec) : [{
      id: `T${i + 1}.evidence`,
      description: 'required turn evidence present',
      verdict: 'NOT_GRADEABLE',
      evidence: `response=${JSON.stringify(rec.response)}`,
    }];
    rec.result = rollTurn(rec.contracts, gradeable);
    turns.push(rec);
  }

  const harnessFail = turns.some((t) => t.result === 'NOT_GRADEABLE');
  const productFail = turns.some((t) => t.result === 'FAIL');
  const overall: ContractVerdict = harnessFail ? 'NOT_GRADEABLE' : productFail ? 'FAIL' : 'PASS';
  const firstFail = turns.find((t) => t.result !== 'PASS');
  const packet: JourneyPacket = {
    schema_version: JOURNEY_SCHEMA_VERSION,
    journey_id: JOURNEY_ID,
    run_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    git,
    seed: 'empty medications table; no profile name; llmReady=false',
    production_seam: 'normalizeInput → processUtterance → ConversationSession + DOMAIN_WRITERS via applyIntents; classifyQuery live; classifyLLM stub empty; setDB better-sqlite3',
    contracts: [
      'T1 capture+confirm, no write',
      'T2 Yes writes Eliquis dose+frequency',
      'T3 list read from store, no write',
      'T4 how-often stored frequency, no write',
      'T5 named recall not profile, no write',
    ],
    turns,
    overall,
    first_material_divergence: firstFail
      ? `T${firstFail.turn} ${firstFail.result}: ${firstFail.contracts.filter((x) => x.verdict !== 'PASS').map((x) => x.id).join(', ') || 'missing evidence'}`
      : null,
    failure_class: harnessFail ? 'HARNESS_FAIL' : productFail ? 'PRODUCT_FAIL' : 'none',
  };
  const artifactPath = writeJourneyPacket(packet, `${JOURNEY_ID}.json`);
  return { packet, artifactPath };
}

export async function runMedicationJourneyS17Tests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- Medication Journey S17 (med.eliquis.s17) ---------------${RESET}\n`);

  const { packet, artifactPath } = await runMedEliquisS17Journey();
  console.log(`  evidence: ${artifactPath}`);
  console.log(`  overall: ${packet.overall}  failure_class=${packet.failure_class}`);
  for (const t of packet.turns) {
    console.log(`  T${t.turn} ${t.result}  in=${JSON.stringify(t.input)}  owner=${t.route_owner} reason=${t.route_reason}`);
    console.log(`       response=${JSON.stringify(t.response)}`);
  }

  check('S17 packet schema_version', packet.schema_version === JOURNEY_SCHEMA_VERSION);
  check('S17 packet journey_id', packet.journey_id === JOURNEY_ID);
  check('S17 five turns recorded', packet.turns.length === 5);
  check('S17 every turn has exact response (gradeable)',
    packet.turns.every((t) => requiredTurnEvidencePresent(t)));
  check('S17 not HARNESS_FAIL', packet.failure_class !== 'HARNESS_FAIL');

  check('S17 T1 capture+pending+no write', packet.turns[0].result === 'PASS');
  check('S17 T2 Yes writes Eliquis dose+frequency', packet.turns[1].result === 'PASS');
  check('S17 T3 list read Eliquis no write', packet.turns[2].result === 'PASS');
  check('S17 T4 how-often stored frequency no write', packet.turns[3].result === 'PASS');
  check('S17 T5 named recall not profile no write', packet.turns[4].result === 'PASS');
  check('S17 overall PASS', packet.overall === 'PASS');

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`${RED}❌ med.eliquis.s17: ${failures.length} failed${RESET}`);
  } else {
    console.log(`${GREEN}✅ med.eliquis.s17: ${passed}/${total} — all green${RESET}`);
  }
  return { passed, failed: failures.length, total, packet, artifactPath };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('medEliquisS17.journey.test.ts')) {
  runMedicationJourneyS17Tests().catch(console.error);
}
