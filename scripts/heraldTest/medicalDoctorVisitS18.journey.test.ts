// Scenario 18 — medical.doctor_visit.s18
// Named past visit + attributed outcome, confirm-gated, then named outcome read.
// Production seam only.

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

const JOURNEY_ID = 'medical.doctor_visit.s18';
const TURNS = [
  'I saw Dr. Patel today. He said my knee looked good.',
  'Yes.',
  'What did Dr. Patel say?',
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
  const recs = t.db_after.medical_records;
  const noWrite = recs.length === 0
    && t.db_diff.medical_records_added.length === 0
    && t.db_diff.medical_records_changed.length === 0;
  const prompt = t.response ?? '';
  return [
    c('A.confirmation_before_write', 'no authoritative visit/outcome before Yes',
      noWrite,
      `records=${recs.length} added=${t.db_diff.medical_records_added.length}`),
    c('T1.capture', 'past visit owned as medical_visit capture',
      t.route_source === 'capture' && t.pending_key_after === 'medical_visit',
      `owner=${t.route_owner} reason=${t.route_reason} source=${t.route_source}`),
    c('T1.confirm_required', 'confirmation pending is live',
      t.pending_after === true && t.pending_key_after === 'medical_visit',
      `pending_after=${t.pending_after} key=${t.pending_key_after}`),
    c('B.grounded_doctor', 'confirm prompt is supported by Dr. Patel',
      /Dr\. Patel/i.test(prompt),
      `response=${JSON.stringify(prompt)}`),
    c('C.grounded_outcome_prompt', 'confirm prompt includes the grounded clause',
      /my knee looked good/i.test(prompt) && !/healthy|prognosis|normal exam/i.test(prompt),
      `response=${JSON.stringify(prompt)}`),
  ];
}

function gradeT2(t: TurnRecord): ContractResult[] {
  const recs = t.db_after.medical_records;
  const row = recs[0];
  const outcomeOk = row?.visit_outcome === 'my knee looked good';
  const doctorOk = row?.doctor_name === 'Dr. Patel';
  return [
    c('D.single_confirm_commit', 'one Yes commits the visit',
      t.route_source === 'pending_resume' && t.pending_key_before === 'medical_visit'
        && t.pending_after === false && recs.length === 1,
      `source=${t.route_source} records=${recs.length} pending_after=${t.pending_after}`),
    c('T2.doctor', 'committed doctor_name is Dr. Patel',
      doctorOk,
      `doctor_name=${row?.doctor_name ?? 'null'}`),
    c('C.grounded_outcome_db', 'visit_outcome is the exact grounded clause',
      outcomeOk,
      `visit_outcome=${JSON.stringify(row?.visit_outcome ?? null)}`),
    c('T2.no_fabricate', 'no extra visit rows or inferred clinical outcome',
      recs.length === 1 && doctorOk && outcomeOk
        && !/healthy|prognosis|normal exam|no knee problems/i.test(JSON.stringify(row)),
      `row=${JSON.stringify(row ?? null)}`),
  ];
}

function gradeT3(t: TurnRecord): ContractResult[] {
  const wrote = t.db_diff.medical_records_added.length
    + t.db_diff.medical_records_removed.length
    + t.db_diff.medical_records_changed.length;
  const text = t.response ?? '';
  const profileDump = /your name is/i.test(text) || /still learning about you/i.test(text)
    || t.route_reason === 'memory:probe' || t.route_kind === 'memory_probe';
  return [
    c('E.named_medical_read', 'authoritative visit_outcome read',
      t.route_kind === 'device_read' && t.route_reason === 'medical:visit_outcome_read',
      `kind=${t.route_kind} reason=${t.route_reason}`),
    c('F.read_matches_commit', 'read recovers the committed clause, no extra clinical meaning',
      /my knee looked good/i.test(text) && /Dr\. Patel/i.test(text)
        && !/healthy|prognosis|normal exam|no knee problems/i.test(text),
      `response=${JSON.stringify(text)}`),
    c('T3.not_profile', 'does not fall into generic profile recall',
      !profileDump,
      `reason=${t.route_reason} response=${JSON.stringify(text)}`),
    c('T3.no_write', 'outcome read does not write',
      wrote === 0,
      `diff_ops=${wrote}`),
  ];
}

const GRADERS = [gradeT1, gradeT2, gradeT3];

export async function runMedicalDoctorVisitS18Journey(): Promise<{ packet: JourneyPacket; artifactPath: string }> {
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
    seed: 'empty medical_records; llmReady=false',
    production_seam: 'normalizeInput → processUtterance → ConversationSession + DOMAIN_WRITERS via applyIntents; classifyQuery live; classifyLLM stub empty; setDB better-sqlite3',
    contracts: [
      'A confirmation_before_write',
      'B grounded_doctor',
      'C grounded_outcome',
      'D single_confirm_commit',
      'E existing_reader_works',
      'F read_matches_commit',
      'G evidence_sufficient',
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

export async function runMedicalDoctorVisitS18Tests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- Doctor/Medical Journey S18 (medical.doctor_visit.s18) --${RESET}\n`);

  const { packet, artifactPath } = await runMedicalDoctorVisitS18Journey();
  console.log(`  evidence: ${artifactPath}`);
  console.log(`  overall: ${packet.overall}  failure_class=${packet.failure_class}`);
  for (const t of packet.turns) {
    console.log(`  T${t.turn} ${t.result}  in=${JSON.stringify(t.input)}  owner=${t.route_owner} reason=${t.route_reason}`);
    console.log(`       response=${JSON.stringify(t.response)}`);
    console.log(`       records=${JSON.stringify(t.db_after.medical_records)}`);
  }

  check('S18 packet schema_version', packet.schema_version === JOURNEY_SCHEMA_VERSION);
  check('S18 packet journey_id', packet.journey_id === JOURNEY_ID);
  check('S18 three turns recorded', packet.turns.length === 3);
  check('S18 every turn has exact response (gradeable)',
    packet.turns.every((t) => requiredTurnEvidencePresent(t)));
  check('S18 not HARNESS_FAIL', packet.failure_class !== 'HARNESS_FAIL');
  check('S18 T1 pending capture no write', packet.turns[0].result === 'PASS');
  check('S18 T2 Yes commits doctor+outcome', packet.turns[1].result === 'PASS');
  check('S18 T3 named outcome read', packet.turns[2].result === 'PASS');
  check('S18 overall PASS', packet.overall === 'PASS');
  check('S18 G evidence_sufficient',
    packet.turns.every((t) => requiredTurnEvidencePresent(t))
      && packet.turns[0].db_before.medical_records.length === 0
      && packet.turns[0].pending_after === true
      && packet.turns[1].db_after.medical_records[0]?.visit_outcome === 'my knee looked good');

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`${RED}❌ medical.doctor_visit.s18: ${failures.length} failed${RESET}`);
  } else {
    console.log(`${GREEN}✅ medical.doctor_visit.s18: ${passed}/${total} — all green${RESET}`);
  }
  return { passed, failed: failures.length, total, packet, artifactPath };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('medicalDoctorVisitS18.journey.test.ts')) {
  runMedicalDoctorVisitS18Tests().catch(console.error);
}
