// scripts/heraldTest/conversationalPresentationContract.test.ts
// Conversational Presentation Contract V1 — Build C bypass for Semantic
// Interpretation ADMIT + medication-domain confirmation/commit wording.
// Does not change Semantic Interpretation V1 admission rules.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { applyIntents, processUtterance } from '../../src/routing/processUtterance.ts';
import { routeIntent, DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { CAPABILITY_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/capabilityRouting.ts';
import { detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
import { getActiveMedications } from '../../src/db/medicalDB.ts';
import type { ClassifyOutcome, IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const BUILD_C = "Say yes and I'll remember that.";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dosage TEXT,
    frequency TEXT,
    prescribing_doctor TEXT,
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER DEFAULT 1,
    notes TEXT,
    created_at TEXT,
    removed_at TEXT
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

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

function mockProposalCtx(focus: string, mentions?: string[]) {
  const payload = JSON.stringify({
    mentions: mentions ?? [focus],
    predicate: 'take',
    focus,
    confidence: 0.95,
  });
  return {
    completion: async (opts?: { messages?: Array<{ content?: string }> }) => {
      const sys = String(opts?.messages?.[0]?.content ?? '');
      if (sys === CAPABILITY_PROPOSAL_SYSTEM_PROMPT) {
        return {
          content: JSON.stringify({
            capability: 'medication.capture',
            confidence: 'high',
            mentions: mentions ?? [focus],
            predicate: 'take',
            focus,
            score: 0.95,
          }),
        };
      }
      return { content: payload };
    },
  } as any;
}

function mockClassify(intents: IntentRecord[]): ClassifyOutcome {
  return { status: 'ok', intents };
}

export async function runConversationalPresentationContractTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Conversational Presentation Contract V1 --${RESET}\n`);

  // ── Semantic ADMIT: provenance + writer confirm, never Build C ───────────
  {
    fresh();
    const text = 'My cardiologist put me on Eliquis.';
    const session = new ConversationSession();
    const decision = await routeIntent(text, {
      classifyQuery,
      classifyLLM: async () => mockClassify([]),
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
      getMedicationSemanticInterpreterCtx: () => mockProposalCtx('Eliquis'),
    });
    assert('CPC1 semantic ADMIT retains source llm', decision.kind === 'capture' && decision.source === 'llm', (v) => v === true, "source: 'llm'");
    assert('CPC2 semantic ADMIT reason is semantic_proposal:medication_admit', decision.kind === 'capture' ? decision.reason : null, (v) => v === 'semantic_proposal:medication_admit', 'semantic_proposal:medication_admit');

    const outcome = await processUtterance(text, session, {
      classifyQuery,
      classifyLLM: async () => mockClassify([]),
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
      getMedicationSemanticInterpreterCtx: () => mockProposalCtx('Eliquis'),
    });
    assert('CPC3 first response is medication-domain confirmation', outcome.responseText, (v) => v === "You're taking Eliquis. Want me to remember that?", "You're taking Eliquis. Want me to remember that?");
    assert('CPC4 first response is never generic Build C', outcome.responseText, (v) => v !== BUILD_C, `not "${BUILD_C}"`);
    assert('CPC5 first turn is pending (confirmation-before-write)', outcome.commits[0]?.status, (v) => v === 'pending', 'pending');
    assert('CPC6 no medication row before confirmation', getActiveMedications().length, (v) => v === 0, '0');
  }

  // ── Genuine classifyLLM captures still use Build C ───────────────────────
  {
    fresh();
    const session = new ConversationSession();
    const t1 = await applyIntents(
      [{ type: 'medical_capture', drug: 'Eliquis', raw: 'My prescription for Eliquis needs a refill.' }],
      'My prescription for Eliquis needs a refill.',
      session,
      undefined,
      'llm',
    );
    assert('CPC7 genuine llm applyIntents still uses Build C', t1.responseText, (v) => v === BUILD_C, BUILD_C);
    assert('CPC8 genuine llm path does not call writer on first turn', t1.commits[0]?.status === 'pending' && t1.commits[0].pendingKey.startsWith('llm_confirm:'), (v) => v === true, 'llm_confirm pending');
    assert('CPC9 genuine llm path writes nothing before yes', getActiveMedications().length, (v) => v === 0, '0');
  }

  // ── Confirmation truthfully includes available fields only ───────────────
  {
    fresh();
    const session = new ConversationSession();
    const drugOnly = await DOMAIN_WRITERS.medical_capture!.add(
      { type: 'medical_capture', drug: 'Eliquis', raw: 'My cardiologist put me on Eliquis.' },
      'My cardiologist put me on Eliquis.',
    );
    assert('CPC10 drug-only confirmation', drugOnly.status === 'pending' ? drugOnly.prompt : null, (v) => v === "You're taking Eliquis. Want me to remember that?", "You're taking Eliquis. Want me to remember that?");

    const withDosage = await DOMAIN_WRITERS.medical_capture!.add(
      { type: 'medical_capture', drug: 'Lisinopril', dosage: '10mg', raw: 'The pharmacy filled my Lisinopril 10mg refill today.' },
      'The pharmacy filled my Lisinopril 10mg refill today.',
    );
    assert('CPC11 drug+dosage confirmation', withDosage.status === 'pending' ? withDosage.prompt : null, (v) => v === "You're taking Lisinopril, 10mg. Want me to remember that?", "You're taking Lisinopril, 10mg. Want me to remember that?");

    const withFreq = await DOMAIN_WRITERS.medical_capture!.add(
      { type: 'medical_capture', drug: 'metformin', frequency: 'twice daily', raw: 'I take metformin twice daily as prescribed.' },
      'I take metformin twice daily as prescribed.',
    );
    assert('CPC12 drug+frequency confirmation uses space, not comma', withFreq.status === 'pending' ? withFreq.prompt : null, (v) => v === "You're taking metformin twice daily. Want me to remember that?", "You're taking metformin twice daily. Want me to remember that?");

    const withBoth = await DOMAIN_WRITERS.medical_capture!.add(
      { type: 'medical_capture', drug: 'Prozac', dosage: '20milligrams', frequency: 'daily', raw: "I've been on 20 milligrams of Prozac daily for a month." },
      "I've been on 20 milligrams of Prozac daily for a month.",
    );
    assert('CPC13 drug+dosage+frequency confirmation', withBoth.status === 'pending' ? withBoth.prompt : null, (v) => v === "You're taking Prozac, 20milligrams, daily. Want me to remember that?", "You're taking Prozac, 20milligrams, daily. Want me to remember that?");

    assert('CPC14 missing dosage/frequency are not invented', drugOnly.status === 'pending' ? drugOnly.prompt : '', (v) => !(v as string).includes('mg') && !(v as string).includes('daily'), 'no invented dosage/frequency');
  }

  // ── Commit wording: new vs update; no recitation ─────────────────────────
  {
    fresh();
    const session = new ConversationSession();
    const raw = 'My cardiologist put me on Eliquis.';
    const first = await applyIntents(
      [{ type: 'medical_capture', drug: 'Eliquis', raw }],
      raw,
      session,
      undefined,
      'llm',
      { domainConfirmOwnsCapture: true },
    );
    assert('CPC15 domainConfirmOwnsCapture skips Build C', first.responseText, (v) => v === "You're taking Eliquis. Want me to remember that?", "You're taking Eliquis. Want me to remember that?");
    const created = await session.resolvePending('yes');
    assert('CPC16 successful new capture ack', created.ack, (v) => v === "Got it. I'll remember that.", "Got it. I'll remember that.");
    assert('CPC17 new capture persists after yes', getActiveMedications().some((m) => m.name === 'Eliquis'), (v) => v === true, 'Eliquis row');

    const session2 = new ConversationSession();
    const second = await applyIntents(
      [{ type: 'medical_capture', drug: 'Eliquis', dosage: '5mg', raw: 'My cardiologist put me on Eliquis 5mg.' }],
      'My cardiologist put me on Eliquis 5mg.',
      session2,
      undefined,
      'deterministic',
    );
    assert('CPC18 update confirm still pending', second.commits[0]?.status, (v) => v === 'pending', 'pending');
    const updated = await session2.resolvePending('yes');
    assert('CPC19 successful update ack', updated.ack, (v) => v === "Got it. I've updated it.", "Got it. I've updated it.");
    assert('CPC20 update ack does not recite the record', updated.ack, (v) => v === "Got it. I've updated it." && !(v as string).includes('Eliquis'), 'no recitation');
  }

  // ── Tier-1 deterministic floor remains authoritative ─────────────────────
  {
    fresh();
    const text = 'My doctor prescribed metformin.';
    assert('CPC21 floor still claims EP4', detectMedicalEvent(text)?.type, (v) => v === 'medication', 'medication');
    const decision = await routeIntent(text, {
      classifyQuery,
      classifyLLM: async () => mockClassify([]),
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
      getMedicationSemanticInterpreterCtx: () => mockProposalCtx('metformin'),
    });
    assert('CPC22 floor path is deterministic capture, not semantic ADMIT', decision.kind === 'capture' && decision.source === 'deterministic' && decision.reason !== 'semantic_proposal:medication_admit', (v) => v === true, "source deterministic, not semantic_proposal:medication_admit");
    const session = new ConversationSession();
    const outcome = await processUtterance(text, session, {
      classifyQuery,
      classifyLLM: async () => mockClassify([]),
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
    });
    assert('CPC23 floor first response is domain confirmation, not Build C', outcome.responseText, (v) => typeof v === 'string' && (v as string).startsWith("You're taking metformin") && v !== BUILD_C, "You're taking metformin...");
    assert('CPC24 floor writes nothing before yes', getActiveMedications().length, (v) => v === 0, '0');
  }

  // ── Semantic negative / fallthrough unchanged ────────────────────────────
  {
    fresh();
    const text = 'I take my grandson fishing.';
    const decision = await routeIntent(text, {
      classifyQuery,
      classifyLLM: async () => mockClassify([]),
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
      getMedicationSemanticInterpreterCtx: () => mockProposalCtx('grandson'),
    });
    assert('CPC25 semantic negative does not semantically ADMIT medication', (
      decision.kind !== 'capture'
      || decision.reason !== 'semantic_proposal:medication_admit'
    ) && !(decision.kind === 'capture' && decision.intents.some((i) => i.type === 'medical_capture')), (v) => v === true, 'not semantic/medical capture');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationalPresentationContract: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationalPresentationContract.test.ts')) {
  runConversationalPresentationContractTests().catch(console.error);
}
