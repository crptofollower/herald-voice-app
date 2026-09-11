// scripts/heraldTest/capabilityRouting.test.ts
// Natural Language Authority V1 / Slice 1 — medication catalog READ.
// Governing design: HERALD_NL_AUTHORITY_ARCHITECTURE_SYNTHESIS_2026-09-07.md
//
// Imports the REAL src/routing/capabilityRouting.ts, the REAL routeIntent.ts,
// the REAL classifyQuery, and the REAL composeMedicalSummary reader — tests can
// never drift from code. The 3B interpreter is replaced by a mock LlamaContext
// whose completion() returns a fixed JSON string, so these tests exercise the
// deterministic admission + routing + authoritative-reader wiring without a
// model. The device-proof utterances appear ONLY as test inputs here; they are
// never encoded into any production language rule.
//
// Runner: wired from run.mjs (EXPECTED_TOTAL bump).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { composeMedicalSummary } from '../../src/db/medicalDB.ts';
import {
  parseCapabilityProposal,
  admitCapabilityProposal,
  CAPABILITY_IDS,
  CAPABILITY_RISK_CLASS,
  type CapabilityProposal,
  type CapabilityId,
} from '../../src/routing/capabilityRouting.ts';
import type { ClassifyOutcome } from '../../src/hooks/llmLayers.ts';
import { mayRunGenerativeEphemeralPersonalProse } from '../../src/utils/ephemeralSeam.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Fresh in-memory DB. Creates the medications + medical_contacts tables WITH
// removed_at (the soft-delete column ACTIVE_MEDICATION_PREDICATE requires) so
// the authoritative reader runs against real rows.
function freshDB() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE medications (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
      prescribing_doctor TEXT, start_date TEXT, end_date TEXT,
      is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT NOT NULL,
      removed_at TEXT
    );
    CREATE TABLE medical_contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, specialty TEXT, phone TEXT,
      address TEXT, is_primary INTEGER DEFAULT 0, notes TEXT,
      created_at TEXT NOT NULL, removed_at TEXT
    );
  `);
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

function seedMedication(db: any, name: string, dosage?: string, frequency?: string) {
  db.prepare(
    `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
     VALUES (?, ?, ?, ?, 1, ?, NULL);`
  ).run(`med_${name}`, name, dosage ?? null, frequency ?? null, new Date().toISOString());
}

function medicationRowCount(db: any): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM medications').get() as { n: number }).n;
}

// Mock LlamaContext: completion() returns a fixed string regardless of input.
function mockCtx(returns: string): any {
  return { completion: async () => ({ content: returns }) };
}

const READ_SUMMARY_JSON = '{"capability":"medication.read_summary","confidence":"high"}';

function makeDeps(ctxReturns: string | null) {
  return {
    classifyQuery,
    classifyLLM: null as ((t: string) => Promise<ClassifyOutcome>) | null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: [] },
    getMedicationSemanticInterpreterCtx: () => (ctxReturns === null ? null : mockCtx(ctxReturns)),
  };
}

export async function runCapabilityRoutingTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Capability Routing V1 / Slice 1: medication catalog READ --${RESET}\n`);

  // ─── Contract shape / risk class ──────────────────────────────────────────
  assert('vocabulary includes the wired read capability',
    CAPABILITY_IDS.includes('medication.read_summary' as CapabilityId), (v) => v === true, 'true');
  assert('vocabulary includes meaningful non-medication off-ramps',
    ['list.read', 'todo.read', 'todo.capture', 'calendar.read', 'contact.call', 'other', 'grocery.capture', 'uncertain'].every((c) => CAPABILITY_IDS.includes(c as CapabilityId)),
    (v) => v === true, 'true');
  assert('read capability risk class is read',
    CAPABILITY_RISK_CLASS['medication.read_summary'], (v) => v === 'read', 'read');
  assert('write capability risk class is write (never read)',
    CAPABILITY_RISK_CLASS['medication.capture'], (v) => v === 'write', 'write');
  assert('grocery.capture risk class is write (never read)',
    CAPABILITY_RISK_CLASS['grocery.capture'], (v) => v === 'write', 'write');
  assert('todo.capture risk class is write (never read)',
    CAPABILITY_RISK_CLASS['todo.capture'], (v) => v === 'write', 'write');
  assert('uncertain risk class is none',
    CAPABILITY_RISK_CLASS['uncertain'], (v) => v === 'none', 'none');

  // ─── parse: malformed / unknown cannot become a proposal ──────────────────
  assert('parse rejects non-JSON', parseCapabilityProposal('not json at all'), (v) => v === null, 'null');
  assert('parse rejects empty', parseCapabilityProposal(''), (v) => v === null, 'null');
  assert('parse rejects unknown capability',
    parseCapabilityProposal('{"capability":"medication.delete_all","confidence":"high"}'), (v) => v === null, 'null');
  assert('parse rejects missing confidence',
    parseCapabilityProposal('{"capability":"medication.read_summary"}'), (v) => v === null, 'null');
  assert('parse rejects out-of-set confidence',
    parseCapabilityProposal('{"capability":"medication.read_summary","confidence":"0.9"}'), (v) => v === null, 'null');
    assert('parse accepts a well-formed read proposal',
      parseCapabilityProposal(READ_SUMMARY_JSON),
      (v) => (v as CapabilityProposal | null)?.capability === 'medication.read_summary', 'read_summary proposal');
  assert('parse accepts todo.capture write payload without changing capability vocab',
    parseCapabilityProposal(JSON.stringify({
      capability: 'todo.capture',
      confidence: 'high',
      op: 'todo_capture',
      candidates: ['water the plants'],
      score: 0.92,
    })),
    (v) => (v as CapabilityProposal | null)?.write?.candidates?.[0] === 'water the plants'
      && (v as CapabilityProposal | null)?.capability === 'todo.capture',
    'todo write payload');
  assert('parse rejects write score outside 0-1',
    parseCapabilityProposal(JSON.stringify({
      capability: 'todo.capture',
      confidence: 'high',
      op: 'todo_capture',
      candidates: ['water the plants'],
      score: 1.5,
    })),
    (v) => v === null, 'null');
  assert('parse rejects non-string write candidates',
    parseCapabilityProposal('{"capability":"grocery.capture","confidence":"high","op":"grocery_capture","candidates":[1],"score":0.9}'),
    (v) => v === null, 'null');

  // ─── admission: only the wired read capability, non-low confidence, ADMITs ─
  const admit = (capability: CapabilityId, confidence: 'high' | 'medium' | 'low') =>
    admitCapabilityProposal({ capability, confidence });
  assert('ADMIT_READ for read_summary @ high', admit('medication.read_summary', 'high').decision, (v) => v === 'ADMIT_READ', 'ADMIT_READ');
  assert('ADMIT_READ for read_summary @ medium', admit('medication.read_summary', 'medium').decision, (v) => v === 'ADMIT_READ', 'ADMIT_READ');
  assert('ABSTAIN for read_summary @ low (confidence downgrades only)', admit('medication.read_summary', 'low').decision, (v) => v === 'ABSTAIN', 'ABSTAIN');
  // A write capability can NEVER be executed from the read admission path.
  assert('ABSTAIN for medication.capture (write off-ramp — never ADMIT_READ)', admit('medication.capture', 'high').decision, (v) => v === 'ABSTAIN', 'ABSTAIN');
  // Unrelated input cannot be forced into medication: every off-ramp abstains.
  for (const offramp of ['list.read', 'todo.read', 'todo.capture', 'calendar.read', 'contact.call', 'other', 'grocery.capture', 'uncertain'] as CapabilityId[]) {
    assert(`ABSTAIN for off-ramp ${offramp}`, admit(offramp, 'high').decision, (v) => v === 'ABSTAIN', 'ABSTAIN');
  }

  // ─── Integration: valid proposal → authoritative reader (real SQLite) ──────
  {
    const db = freshDB();
    seedMedication(db, 'Lisinopril', '10mg', 'once daily');
    seedMedication(db, 'Metformin', '500mg', 'twice daily');
    const before = medicationRowCount(db);

    // An unseen wording no legacy regex bank covers — used ONLY as input here.
    const utterance = 'What medications did I tell you I\'m taking?';

    // Prove the legacy deterministic banks genuinely MISS this wording (so it is
    // the semantic capability path, not a regex, that claims it).
    const legacy = await classifyQuery(utterance);
    assert('legacy classifyQuery does NOT claim the unseen wording (tier 3)', legacy.tier, (v) => v === 3, 'tier 3');

    const decision = await routeIntent(utterance, makeDeps(READ_SUMMARY_JSON));
    assert('unseen catalog-read reaches a device_read', decision.kind, (v) => v === 'device_read', 'device_read');
    assert('device_read uses the authoritative medical:summary reader reason',
      (decision as any).reason, (v) => v === 'medical:summary', 'medical:summary');
    assert('response content comes from the authoritative reader (real rows)',
      (decision as any).response, (v) => typeof v === 'string' && (v as string).includes('Lisinopril') && (v as string).includes('Metformin'),
      'summary naming seeded meds');
    assert('response equals composeMedicalSummary() verbatim (no model prose)',
      (decision as any).response, (v) => v === composeMedicalSummary().response, 'reader output verbatim');
    assert('presentedMedicationIds carried for ordinal follow-ups',
      (decision as any).presentedMedicationIds, (v) => Array.isArray(v) && (v as string[]).length === 2, '2 ids');

    // Read cannot reach a writer / cannot mutate.
    assert('read path did not create/alter any medication row', medicationRowCount(db), (v) => v === before, `${before}`);
    assert('read path did not return a capture (write) decision', decision.kind, (v) => v !== 'capture', 'not capture');
  }

  // ─── After the read path claims it, generic generation cannot answer ───────
  // A claimed catalog read returns a terminal tier-1 device_read. In ChatScreen
  // that dispatches the authoritative reader and returns — it never reaches the
  // needs_clarification / backend / memory_probe kinds that feed the generative
  // Qwen ephemeral personal-recall path. Proven structurally by the kind.
  {
    const db = freshDB();
    seedMedication(db, 'Eliquis', '5mg');
    const decision = await routeIntent('Remind me what pills I take.', makeDeps(READ_SUMMARY_JSON));
    assert('claimed read is terminal device_read (not needs_clarification)',
      decision.kind, (v) => v === 'device_read', 'device_read');
    assert('claimed read is not backend (no network/Qwen handoff)',
      decision.kind, (v) => v !== 'backend', 'not backend');
    assert('claimed read is not memory_probe (no ephemeral seam handoff)',
      decision.kind, (v) => v !== 'memory_probe', 'not memory_probe');
  }

  // ─── Malformed / unavailable proposal cannot execute the read path ─────────
  {
    const db = freshDB();
    seedMedication(db, 'Warfarin');
    const before = medicationRowCount(db);
    // Model emits garbage → parse_fail → fall through unchanged.
    const malformed = await routeIntent('What medications did I tell you I\'m taking?', makeDeps('completely unparseable ~~~'));
    assert('malformed proposal does NOT reach a device_read', malformed.kind, (v) => v !== 'device_read', 'not device_read');
    assert('malformed proposal falls through to needs_clarification', malformed.kind, (v) => v === 'needs_clarification', 'needs_clarification');
    // Interpreter unavailable (ctx null) → fall through unchanged.
    const unavailable = await routeIntent('What medications did I tell you I\'m taking?', makeDeps(null));
    assert('unavailable interpreter does NOT reach a device_read', unavailable.kind, (v) => v !== 'device_read', 'not device_read');
    assert('unavailable interpreter falls through to needs_clarification', unavailable.kind, (v) => v === 'needs_clarification', 'needs_clarification');
    assert('malformed/unavailable did not mutate medications', medicationRowCount(db), (v) => v === before, `${before}`);
  }

  // ─── Unrelated input: the model picks an off-ramp → read path abstains ─────
  {
    const db = freshDB();
    seedMedication(db, 'Atorvastatin');
    const before = medicationRowCount(db);
    // Model correctly proposes a non-medication capability for unrelated speech.
    const decision = await routeIntent('what is the capital of France',
      makeDeps('{"capability":"other","confidence":"high"}'));
    assert('unrelated input is NOT forced into a medication read', decision.kind, (v) => v !== 'device_read', 'not device_read');
    assert('unrelated input did not mutate medications', medicationRowCount(db), (v) => v === before, `${before}`);
  }

  // ─── SAFING (pre-commit correction): an unresolved personal medication ─────
  //     recall the interpreter IDENTIFIED (proposed medication.read_summary)
  //     but could NOT admit (low confidence) must never reach the generative
  //     Qwen path. It declines with reason 'personal_memory:recall_declined'
  //     (reason !== 'default'), which structurally blocks generation.
  {
    const db = freshDB();
    seedMedication(db, 'Lisinopril', '10mg');
    // Non-recall-shaped catalog-read paraphrase that misses every legacy bank:
    // WITHOUT the safing this reaches needs_clarification:'default' →
    // generative-eligible. It is NOT recall-shaped, so the Site-A fence does
    // not catch it — proving the safing (not the fence) is what declines it.
    const input = 'run through my current prescriptions for me';
    const legacy = await classifyQuery(input);
    assert('SAFING precondition: legacy misses to tier 3 default (not the recall fence)',
      `${legacy.tier}:${legacy.reason}`, (v) => v === '3:default', '3:default');

    const lowConf = '{"capability":"medication.read_summary","confidence":"low"}';
    const decision = await routeIntent(input, makeDeps(lowConf));
    assert('unresolved med-recall (low conf) does NOT reach a device_read', decision.kind, (v) => v !== 'device_read', 'not device_read');
    assert('unresolved med-recall declines as needs_clarification', decision.kind, (v) => v === 'needs_clarification', 'needs_clarification');
    assert('unresolved med-recall uses recall-declined reason (NOT default)',
      (decision as any).reason, (v) => v === 'personal_memory:recall_declined', 'personal_memory:recall_declined');
    assert('unresolved med-recall reason is not the generative-eligible default',
      (decision as any).reason, (v) => v !== 'default', "not 'default'");
  }

  // ─── SAFING structural proof: the decline reason blocks generative prose ────
  //     mayRunGenerativeEphemeralPersonalProse is the exact gate ChatScreen
  //     consults before letting Qwen answer. Prove the reason we return turns
  //     it OFF, and that 'default' (the pre-safing outcome) would have turned
  //     it ON — so the safing is what closes the hole.
  {
    const seamInput = (reason: string) => ({
      reason,
      text: 'run through my current prescriptions for me',
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      isEligible: true,
    });
    assert('generative prose BLOCKED for personal_memory:recall_declined',
      mayRunGenerativeEphemeralPersonalProse(seamInput('personal_memory:recall_declined')),
      (v) => v === false, 'false');
    assert('generative prose WOULD be allowed for default (proves the safing matters)',
      mayRunGenerativeEphemeralPersonalProse(seamInput('default')),
      (v) => v === true, 'true');
  }

  // ─── SAFING scope: an off-ramp abstain is NOT declined as a med recall ──────
  //     Only a proposal the model itself called medication.read_summary is
  //     safed. An off-ramp ('other') on unrelated input still falls through
  //     unchanged — the safing does not over-capture.
  {
    const db = freshDB();
    const input = 'what is the capital of France';
    const decision = await routeIntent(input, makeDeps('{"capability":"other","confidence":"low"}'));
    assert('off-ramp low-conf is NOT declined as a medication recall',
      (decision as any).reason, (v) => v !== 'personal_memory:recall_declined', "not recall-declined");
    assert('off-ramp low-conf falls through to default clarification',
      decision.kind, (v) => v === 'needs_clarification', 'needs_clarification');
  }

  // ─── Existing capture behavior unchanged: the deterministic floor precedes ─
  // A floor-claimed medication capture is mapped by classifyQuery BEFORE the
  // read block runs. Even with a read-ADMIT mock present, routeIntent returns a
  // capture — proving the read path neither hijacks nor alters captures, and
  // the CrossFit/write negative controls (owned by other suites) are untouched.
  {
    const db = freshDB();
    const decision = await routeIntent('I started taking metformin 500 milligrams twice a day.', makeDeps(READ_SUMMARY_JSON));
    assert('floor-claimed medication capture still routes to capture (read block does not hijack)',
      decision.kind, (v) => v === 'capture', 'capture');
    assert('capture is deterministic-sourced (unchanged write path)',
      (decision as any).source, (v) => v === 'deterministic', 'deterministic');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}CapabilityRouting: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('capabilityRouting.test.ts')) {
  runCapabilityRoutingTests().catch(console.error);
}
