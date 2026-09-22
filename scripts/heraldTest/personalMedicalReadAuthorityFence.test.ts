// Personal Medical Read Authority Fence V1.
// Slice 1: semantic medication.read_summary requires hasMedicationDomainEvidence.
// Slice 2: object-bearing unresolved see-X cannot reach getLastVisit(undefined).

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { admitCapabilityProposal } from '../../src/routing/capabilityRouting.ts';
import { composeMedicalSummary } from '../../src/db/medicalDB.ts';
import { hasMedicationDomainEvidence, detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
import { setNow, resetNow } from '../../src/utils/heraldClock.ts';
import { setCalendarEventFetcher, resetCalendarEventFetcher } from '../../src/db/calendarCacheDB.ts';
import type { ClassifyOutcome } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const READ_SUMMARY_JSON = '{"capability":"medication.read_summary","confidence":"high"}';
const LAST_DOCTOR_SAW = 'When was the last doctor I saw?';
const PIN = new Date(2026, 8, 21, 15, 0, 0);

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

async function freshMigrated() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  return db;
}

function seedMedication(db: Database.Database, name: string, dosage?: string) {
  db.prepare(
    `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
     VALUES (?, ?, ?, NULL, 1, ?, NULL);`,
  ).run(`med_${name}`, name, dosage ?? null, new Date().toISOString());
}

function mockCtx(returns: string): any {
  return { completion: async () => ({ content: returns }) };
}

function makeDeps(ctxReturns: string | null) {
  return {
    classifyQuery,
    classifyLLM: null as ((t: string) => Promise<ClassifyOutcome>) | null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
    getMedicationSemanticInterpreterCtx: () => (ctxReturns === null ? null : mockCtx(ctxReturns)),
  };
}

function speechOf(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  return 'responseText' in outcome && typeof outcome.responseText === 'string' ? outcome.responseText : '';
}

export async function runPersonalMedicalReadAuthorityFenceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Personal Medical Read Authority Fence V1 --${RESET}\n`);

  setNow(PIN);
  setCalendarEventFetcher(async () => ({ status: 'unavailable', reason: 'permission-denied' }));
  try {
    // 1. Deterministic visit-history miss must not disclose medications.
    {
      const db = await freshMigrated();
      seedMedication(db, 'Lisinopril', '10mg');
      seedMedication(db, 'Metformin', '500mg');
      const legacy = await classifyQuery(LAST_DOCTOR_SAW);
      assert('1 legacy does not enroll last-doctor-I-saw as visit-history',
        `${legacy.tier}:${legacy.reason}`, (v) => v === '3:default', '3:default');
      assert('1 utterance has zero medication-domain evidence',
        hasMedicationDomainEvidence(LAST_DOCTOR_SAW), (v) => v === false, 'false');
      const decision = await routeIntent(LAST_DOCTOR_SAW, makeDeps(READ_SUMMARY_JSON));
      assert('1 stubbed read_summary does not execute medical:summary',
        (decision as any).reason, (v) => v !== 'medical:summary', 'not medical:summary');
      assert('1 stubbed read_summary is not a catalog device_read',
        decision.kind, (v) => v !== 'device_read', 'not device_read');
      const speech = typeof (decision as any).response === 'string' ? (decision as any).response : '';
      assert('1 does not disclose Lisinopril', /lisinopril/i.test(speech), (v) => v === false, 'false');
      assert('1 does not disclose Metformin', /metformin/i.test(speech), (v) => v === false, 'false');
      assert('1 does not equal composeMedicalSummary()',
        speech === composeMedicalSummary().response, (v) => v === false, 'false');
    }

    // 2. High-confidence semantic proposal + zero evidence ⇒ ABSTAIN.
    {
      const admission = admitCapabilityProposal(
        { capability: 'medication.read_summary', confidence: 'high' },
        LAST_DOCTOR_SAW,
      );
      assert('2 high-confidence zero-evidence decision is ABSTAIN',
        admission.decision, (v) => v === 'ABSTAIN', 'ABSTAIN');
      assert('2 abstain reason is no_medication_domain_evidence',
        (admission as any).reason, (v) => v === 'no_medication_domain_evidence', 'no_medication_domain_evidence');
      const appointment = admitCapabilityProposal(
        { capability: 'medication.read_summary', confidence: 'high' },
        'When is my appointment?',
      );
      assert('2 read-shaped non-medication utterance also ABSTAINS',
        appointment.decision, (v) => v === 'ABSTAIN', 'ABSTAIN');
    }

    // 3. Legitimate catalog medication summary remains allowed.
    {
      const db = await freshMigrated();
      seedMedication(db, 'Lisinopril', '10mg');
      const utterance = 'What medications am I taking?';
      assert('3 medications-taking has medication-domain evidence',
        hasMedicationDomainEvidence(utterance), (v) => v === true, 'true');
      const d = await classifyQuery(utterance);
      assert('3 medications-taking is medical:summary', d.reason, (v) => v === 'medical:summary', 'medical:summary');
      assert('3 medications-taking names Lisinopril',
        d.tier1Response, (v) => typeof v === 'string' && /lisinopril/i.test(v), 'names Lisinopril');
    }

    // 4. Named medication inquiry remains a read, never a write / catalog dump.
    {
      const db = await freshMigrated();
      seedMedication(db, 'Lisinopril', '10mg');
      seedMedication(db, 'Metformin', '500mg');
      const utterance = 'Am I taking lisinopril?';
      assert('4 am-I-taking is not a medication capture',
        detectMedicalEvent(utterance), (v) => v === null, 'null');
      const d = await classifyQuery(utterance);
      assert('4 am-I-taking is not a capture action',
        d.reason, (v) => v !== 'action:medical_capture', 'not action:medical_capture');
      const decision = await routeIntent(utterance, makeDeps(READ_SUMMARY_JSON));
      assert('4 stubbed read_summary cannot dump the catalog as medical:summary',
        (decision as any).reason, (v) => v !== 'medical:summary', 'not medical:summary');
      const speech = typeof (decision as any).response === 'string' ? (decision as any).response : '';
      assert('4 does not disclose unrelated Metformin via catalog summary',
        /metformin/i.test(speech), (v) => v === false, 'false');
    }

    async function seededVisitQuery(utterance: string) {
      await freshMigrated();
      writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-08-01', status: 'noted' });
      return classifyQuery(utterance);
    }

    // Named visit-history read unchanged.
    {
      await freshMigrated();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', notes: 'visit', visit_date: '2026-08-12', status: 'noted' });
      const d = await classifyQuery('When did I last see Dr. Vance?');
      assert('named Vance read is visit_history_read',
        d.reason, (v) => v === 'medical:visit_history_read', 'medical:visit_history_read');
      assert('named Vance read names Dr. Vance',
        d.tier1Response, (v) => typeof v === 'string' && /Vance/i.test(v), 'names Vance');
    }

    // Generic unhinted visit-history reads remain valid.
    {
      const visit = await seededVisitQuery('When was my last doctor visit?');
      assert('last doctor visit is visit_history_read',
        visit.reason, (v) => v === 'medical:visit_history_read', 'medical:visit_history_read');
      assert('last doctor visit may name the newest visit',
        visit.tier1Response, (v) => typeof v === 'string' && /Patel/i.test(v), 'names Patel');
      const appt = await seededVisitQuery('When was my last appointment?');
      assert('last appointment is visit_history_read',
        appt.reason, (v) => v === 'medical:visit_history_read', 'medical:visit_history_read');
      assert('last appointment may name the newest visit',
        appt.tier1Response, (v) => typeof v === 'string' && /Patel/i.test(v), 'names Patel');
      const who = await seededVisitQuery('Who was my last doctor?');
      assert('who was my last doctor is visit_history_read',
        who.reason, (v) => v === 'medical:visit_history_read', 'medical:visit_history_read');
      assert('who was my last doctor may name the newest visit',
        who.tier1Response, (v) => typeof v === 'string' && /Patel/i.test(v), 'names Patel');
    }

    // Existing recognized specialty pending preserved.
    {
      const d = await seededVisitQuery('When did I last see my oncologist?');
      assert('oncologist is unresolved specialty pending, not an unhinted visit read',
        d.reason, (v) => v === 'medical:visit_history_unresolved_specialty', 'medical:visit_history_unresolved_specialty');
      assert('oncologist clarification does not name the globally newest doctor',
        d.tier1Response, (v) => typeof v === 'string' && /oncologist/i.test(v) && /who do you mean/i.test(v) && !/Patel/i.test(v),
        'specialty clarification, no Patel');
    }

    // Object-bearing unresolved see-X must not substitute the newest visit.
    {
      for (const role of ['dermatologist', 'urologist', 'podiatrist'] as const) {
        const d = await seededVisitQuery(`When did I last see my ${role}?`);
        assert(`${role} is unresolved object, not visit_history_read`,
          d.reason, (v) => v === 'medical:visit_history_unresolved_object', 'medical:visit_history_unresolved_object');
        assert(`${role} is not promoted onto the specialty-pending list`,
          d.reason, (v) => v !== 'medical:visit_history_unresolved_specialty', 'not unresolved_specialty');
        assert(`${role} does not name the globally newest doctor`,
          d.tier1Response, (v) => typeof v === 'string' && !/Patel/i.test(v) && !/You last saw/i.test(v),
          'no Patel visit disclosure');
      }
    }

    // Adversarial non-medical object: no visit substitution, no specialty promotion.
    {
      const d = await seededVisitQuery('When did I last see my florist?');
      assert('florist is not visit_history_read of a seeded doctor',
        d.reason, (v) => v !== 'medical:visit_history_read', 'not visit_history_read');
      assert('florist is not promoted to specialty pending',
        d.reason, (v) => v !== 'medical:visit_history_unresolved_specialty', 'not unresolved_specialty');
      assert('florist does not disclose the seeded medical visit',
        d.tier1Response, (v) => typeof v === 'string' && !/Patel/i.test(v) && !/You last saw/i.test(v),
        'no Patel visit disclosure');
    }

    // Unresolved pronoun remains fail-closed.
    {
      const d = await seededVisitQuery('When did I last see him?');
      assert('last-see-him is unresolved_referent',
        d.reason, (v) => v === 'medical:visit_history_unresolved_referent', 'medical:visit_history_unresolved_referent');
      assert('pronoun clarification does not name Patel',
        d.tier1Response, (v) => typeof v === 'string' && v === "I'm not sure who you mean — which doctor?",
        'clarification, no doctor name');
    }

    // Temporal pending: existing specialty owner + last month preserves constraint.
    {
      await freshMigrated();
      const session = new ConversationSession();
      const deps = makeDeps(null);
      const say = (text: string) => processUtterance(text, session, deps);
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-12', status: 'noted' });
      const first = await say('When did I last see my oncologist last month?');
      assert('oncologist+last-month is handled', first.handled, (v) => v === true, 'true');
      assert('oncologist+last-month arms visit-history specialty pending',
        session.peekPendingKey(), (v) => v === 'medical_visit_history_specialty', 'medical_visit_history_specialty');
      assert('oncologist first turn is clarification, not a substituted doctor',
        speechOf(first), (v) => typeof v === 'string' && /oncologist/i.test(v) && /who do you mean/i.test(v) && !/Vance/i.test(v),
        'clarification');
      const resume = await say('Dr. Vance.');
      assert('named resume settles pending', session.hasPending(), (v) => v === false, 'false');
      assert('resume preserves last-month constraint',
        speechOf(resume), (v) => typeof v === 'string' && /^Yes, you saw Dr\. Vance on /i.test(v) && /August 12/i.test(v),
        'Yes, August 12');
    }
  } finally {
    resetCalendarEventFetcher();
    resetNow();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}PersonalMedicalReadAuthorityFence: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('personalMedicalReadAuthorityFence.test.ts')) {
  runPersonalMedicalReadAuthorityFenceTests().catch(console.error);
}
