// scripts/heraldTest/trustedOwnershipRepair.test.ts
// Production-ordering contract — trusted ownership repair V1.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { parseReadIntentsFromClassifier } from '../../src/routing/readIntent.ts';
import { dispatchReadIntents } from '../../src/routing/readIntent.ts';
import { detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
import { alreadyClassifiedByRouteIntent } from '../../src/utils/llmClassificationOwnership.ts';
import {
  isUnresolvedPersonalCapture,
  type RouteDecision,
} from '../../src/routing/routeIntent.ts';
import {
  EPHEMERAL_CLARIFY_REPLY,
  resolveEphemeralSeam,
} from '../../src/utils/ephemeralSeam.ts';
import { buildBoundedPastEventAcknowledgment } from '../../src/utils/predicateExtensionContainment.ts';
import type { ClassifyOutcome } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function freshDB() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE service_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      removed_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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

function seedPlumber(name: string, phone: string) {
  const db = freshDB();
  db.prepare(
    `INSERT INTO service_providers (category, name, phone) VALUES (?, ?, ?)`,
  ).run('plumber', name, phone);
  return db;
}

export async function runTrustedOwnershipRepairTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, expected: unknown) {
    if (got === expected) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }

  function assertTrue(label: string, cond: boolean) {
    assert(label, cond, true);
  }

  function assertFalse(label: string, cond: boolean) {
    assert(label, cond, false);
  }

  console.log(`\n${BOLD}-- Trusted Ownership Repair V1 (production ordering) --------${RESET}`);

  const sonCaughtUp = 'I saw my son and we caught up for an hour.';
  const theShields = 'The Shields.';
  const drSmith = 'I saw Dr Smith Tuesday.';
  const plumbingMy = 'Who do I call for my plumbing?';
  const plumbingPlain = 'Who do I call for plumbing?';

  // ── T1 composed: processUtterance → needs_clarification/default → ephemeral seam ─
  // Mirrors ChatScreen.sendMessage lines 1387–1417 (without UI/TTS).
  {
    freshDB();
    const session = new ConversationSession();
    let classifyCalls = 0;
    let generateCalled = false;

    const tierDecision = await classifyQuery(sonCaughtUp);
    assertTrue(
      'TOR-T1.1 classifyQuery no tier-1 medical_capture',
      !(tierDecision.tier === 1 && tierDecision.actionIntent?.type === 'medical_capture'),
    );

    const outcome = await processUtterance(sonCaughtUp, session, {
      classifyQuery,
      classifyLLM: async () => {
        classifyCalls++;
        return {
          status: 'ok',
          intents: [{ type: 'medical_visit', raw: sonCaughtUp }],
        } as ClassifyOutcome;
      },
      llmReady: true,
    });

    assertFalse('TOR-T1.2 processUtterance not capture-handled', outcome.handled);
    assertFalse('TOR-T1.3 no medical pending armed', session.hasPending());
    assertTrue(
      'TOR-T1.4 route/process yields needs_clarification default',
      !outcome.handled
        && outcome.routeDecision.kind === 'needs_clarification'
        && outcome.routeDecision.reason === 'default',
    );
    assertTrue(
      'TOR-T1.5 routeDecision not medical capture',
      outcome.routeDecision.kind !== 'capture'
        || !('intents' in outcome.routeDecision
          && outcome.routeDecision.intents.some(i => i.type.startsWith('medical_'))),
    );
    assert('TOR-T1.6 classify invoked once inside processUtterance', classifyCalls, 1);

    const rd = outcome.routeDecision as Extract<RouteDecision, { kind: 'needs_clarification' }>;
    const seamOutcome = await resolveEphemeralSeam({
      text: sonCaughtUp,
      reason: rd.reason,
      readMeta: rd.readMeta,
      hasAuthorizedContinuation: false,
      hasPendingSession: session.hasPending(),
      hasContactCollectPending: false,
      rdTier: 3,
      hasStructuredCaptures: false,
      isPersonalCaptureRisk: isUnresolvedPersonalCapture(rd),
      llmStatus: 'ready',
      classifierBusy: false,
      ephemeralBusy: false,
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Glad you two talked.' };
      },
    });

    assert('TOR-T1.7 seam bounded ack path (generative kind)', seamOutcome.kind, 'generative');
    assert(
      'TOR-T1.8 bounded acknowledgment reply',
      seamOutcome.reply,
      buildBoundedPastEventAcknowledgment(sonCaughtUp),
    );
    assertTrue('TOR-T1.9 generate never invoked', !generateCalled);
    assertTrue(
      'TOR-T1.10 bounded ack grants continuation',
      seamOutcome.kind === 'generative' && seamOutcome.grantContinuation === true,
    );
    assertTrue(
      'TOR-T1.11 no applyIntents/writer path (handled false)',
      outcome.handled === false && !('commits' in outcome),
    );
  }

  // ── T2 composed: processUtterance → needs_clarification/default → ephemeral seam ─
  {
    freshDB();
    const session = new ConversationSession();
    let generateCalled = false;

    const outcome = await processUtterance(theShields, session, {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
    });

    assertFalse('TOR-T2.1 processUtterance not capture-handled', outcome.handled);
    assertFalse('TOR-T2.2 no pending armed', session.hasPending());
    assertTrue(
      'TOR-T2.3 route/process yields needs_clarification default',
      !outcome.handled
        && outcome.routeDecision.kind === 'needs_clarification'
        && outcome.routeDecision.reason === 'default',
    );
    assertTrue(
      'TOR-T2.4 routeDecision not capture',
      outcome.routeDecision.kind !== 'capture',
    );

    const rd = outcome.routeDecision as Extract<RouteDecision, { kind: 'needs_clarification' }>;
    const seamOutcome = await resolveEphemeralSeam({
      text: theShields,
      reason: rd.reason,
      readMeta: rd.readMeta,
      hasAuthorizedContinuation: true,
      hasPendingSession: session.hasPending(),
      hasContactCollectPending: false,
      rdTier: 3,
      hasStructuredCaptures: false,
      isPersonalCaptureRisk: isUnresolvedPersonalCapture(rd),
      llmStatus: 'ready',
      classifierBusy: false,
      ephemeralBusy: false,
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'They sound like a wonderful family.' };
      },
    });

    assert('TOR-T2.5 bare label clarifies even with continuation', seamOutcome.kind, 'clarify');
    assert('TOR-T2.6 safe clarification reply', seamOutcome.reply, EPHEMERAL_CLARIFY_REPLY);
    assertTrue('TOR-T2.7 generate never invoked', !generateCalled);
    assertTrue(
      'TOR-T2.8 no applyIntents/writer path (handled false)',
      outcome.handled === false && !('commits' in outcome),
    );
  }

  // ── T3: ReadIntent plumbing read — single classify, stored plumber ────────
  for (const [label, utterance] of [
    ['my plumbing', plumbingMy],
    ['plain plumbing', plumbingPlain],
  ] as const) {
    seedPlumber('Rosa', '555-0100');
    const readJson = `[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumbing","requested_information":"IDENTITY","raw_phrase":"${utterance}","confidence":"high"}]`;
    const readMeta = parseReadIntentsFromClassifier(readJson, utterance);
    let classifyCalls = 0;
    const rd = await routeIntent(utterance, {
      classifyQuery,
      classifyLLM: async () => {
        classifyCalls++;
        return { status: 'ok', intents: [], readIntents: readMeta.readIntents, readLabeled: readMeta.readLabeled };
      },
      llmReady: true,
    });
    assertTrue(`TOR-T3a ${label} routeIntent classified once`, classifyCalls === 1);
    assertTrue(`TOR-T3b ${label} alreadyClassified skips duplicate`,
      alreadyClassifiedByRouteIntent(rd));
    const dispatch = dispatchReadIntents(readMeta.readIntents, { readLabeled: readMeta.readLabeled });
    assertTrue(`TOR-T3c ${label} read answers from store`,
      dispatch.status === 'answered' && dispatch.responseText.includes('Rosa'));
    assertTrue(`TOR-T3d ${label} completion budget <= 2`, classifyCalls <= 2);
  }

  // ── T4: legitimate Dr Smith visit preserved ───────────────────────────────
  assertTrue('TOR-T4a detectMedicalEvent fires for Dr Smith visit',
    detectMedicalEvent(drSmith)?.type === 'visit');

  {
    freshDB();
    const rd = await routeIntent(drSmith, {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
    });
    assertTrue('TOR-T4b routeIntent medical_visit capture for Dr Smith',
      rd.kind === 'capture' && rd.intents[0]?.type === 'medical_visit');
  }

  // ── T5: pending Yes remains repair-owned ──────────────────────────────────
  {
    freshDB();
    const session = new ConversationSession();
    session.setPending({
      pendingKey: 'medical_visit',
      kind: 'standard',
      budget: 2,
      resume: async () => ({ status: 'committed', ack: 'Confirmed visit.' }),
    });
    let generateCalled = false;
    const outcome = await processUtterance('Yes.', session, {
      classifyQuery,
      classifyLLM: async () => {
        generateCalled = true;
        return { status: 'ok', intents: [] };
      },
      llmReady: true,
    });
    assertTrue('TOR-T5a Yes resolves pending not fresh route', outcome.handled);
    assert('TOR-T5b pending resume source', outcome.source, 'pending_resume');
    assertTrue('TOR-T5c classify never invoked on Yes', !generateCalled);
    const seam = await resolveEphemeralSeam({
      text: 'Yes.',
      reason: 'default',
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      rdTier: 3,
      hasStructuredCaptures: false,
      isPersonalCaptureRisk: false,
      llmStatus: 'ready',
      classifierBusy: false,
      ephemeralBusy: false,
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'fabricated' };
      },
    });
    assertTrue('TOR-T5d bare Yes without pending does not generative when ineligible',
      seam.kind === 'clarify' || !generateCalled);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}TrustedOwnershipRepair: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('trustedOwnershipRepair.test.ts')) {
  runTrustedOwnershipRepairTests().catch(console.error);
}
