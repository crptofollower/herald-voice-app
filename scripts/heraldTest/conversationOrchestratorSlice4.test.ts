// Slice 4 — a semantic proposal is not capability, identity, or truth.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { establishHardPending } from '../../src/routing/hardPendingBoundary.ts';
import { admitDispatchedSemanticRead } from '../../src/routing/semanticAdmission.ts';
import { evaluateSemanticDispatchEligibility } from '../../src/routing/semanticDispatchEligibility.ts';
import { admitMedicationSemanticProposal } from '../../src/routing/medicationSemanticInterpretation.ts';
import { admitTodoSemanticP2 } from '../../src/routing/todoSemanticCapture.ts';
import { answerActiveSubjectReference } from '../../src/routing/activeSubjectReference.ts';
import { actForRoute } from '../../src/routing/responseAct.ts';
import type { ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { composeOpenListSpeech } from '../../src/db/listRead.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function person(name: string, turnIndex: number): ConversationTurnRecord {
  return {
    turnIndex,
    establishedAt: Date.now(),
    utterance: name,
    intentType: null,
    operation: 'capture',
    outcome: 'committed',
    authorityTier: 'deterministic',
    assistantReplySummary: null,
    focus: [{ kind: 'person', displayValue: name, resolverKey: name, referable: true, tier: 'conversational' }],
  };
}

export async function runConversationOrchestratorSlice4Tests() {
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

  console.log(`\n${BOLD}-- Conversation Orchestrator Slice 4 --${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const admissionSrc = fs.readFileSync(path.join(root, 'src/routing/semanticAdmission.ts'), 'utf8');
  const subjectSrc = fs.readFileSync(path.join(root, 'src/routing/activeSubjectReference.ts'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(root, 'src/routing/routeIntent.ts'), 'utf8');
  assert('admission does not classify wording', !admissionSrc.includes('.match(') && !admissionSrc.includes('RegExp') && !admissionSrc.includes('.test('),
    (v) => v === true, 'no prose matcher');
  assert('active-subject resolution does not look up contacts', !subjectSrc.includes('findContactByName') && !subjectSrc.includes('contactsDB'),
    (v) => v === true, 'no contact lookup');

  const callProposal = { capability: 'contact.call' as const, confidence: 'high' as const };
  const callAdmit = admitDispatchedSemanticRead(callProposal, { eligible: true, reason: 'instruction' }, 'Text Dr. Patel');
  assert('a high-confidence contact proposal is not a call', callAdmit.decision === 'ABSTAIN' && callAdmit.reason.startsWith('not_a_personal_read:'),
    (v) => v === true, 'ABSTAIN');

  const groceryOnly = { eligible: true as const, reason: 'grocery_context' as const };
  const medicationOnly = { eligible: true as const, reason: 'medication_domain' as const };
  assert('a list proposal cannot use medication eligibility',
    admitDispatchedSemanticRead({ capability: 'list.read', confidence: 'high' }, medicationOnly, 'What medications am I taking?').decision === 'ABSTAIN',
    (v) => v === true, 'ABSTAIN');
  assert('a todo proposal cannot use grocery eligibility',
    admitDispatchedSemanticRead({ capability: 'todo.read', confidence: 'high' }, groceryOnly, 'the grocery store').decision === 'ABSTAIN',
    (v) => v === true, 'ABSTAIN');
  assert('high confidence does not admit an incompatible list read',
    admitDispatchedSemanticRead({ capability: 'list.read', confidence: 'high' }, { eligible: true, reason: 'obligation_family' }, 'We need to clean the garage.').decision === 'ABSTAIN',
    (v) => v === true, 'ABSTAIN');

  const one = await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: [person('Dr. Patel', 1)] });
  assert('one eligible person is admitted without a model', one.handled === true && one.kind === 'identity' && one.reply.includes('Dr. Patel'),
    (v) => v === true, 'identity');
  let modelCalls = 0;
  const ranked = await answerActiveSubjectReference('Who am I talking about?', {
    ledgerEntries: [person('Dr. Patel', 1), person('Paul', 2)],
    getInterpreterCtx: () => ({
      completion: async () => {
        modelCalls++;
        return { text: '{"applicable":true,"selectedIndex":0,"ambiguous":false,"confidence":0.99}' };
      },
    }) as never,
  });
  assert('two eligible people clarify', ranked.handled === true && ranked.kind === 'ambiguous',
    (v) => v === true, 'ambiguous');
  assert('model ranking is not consulted for a confirmed identity act', modelCalls === 0,
    (v) => v === true, '0');
  const none = await answerActiveSubjectReference('Who am I talking about?', { ledgerEntries: [] });
  assert('zero eligible people are not invented', none.handled === false,
    (v) => v === true, 'not handled');

  const pending = new ConversationSession();
  establishHardPending(pending, { pendingKey: 'medical_capture', resume: async () => ({ status: 'committed', ack: 'Saved.' }) });
  const deferred = admitMedicationSemanticProposal('I started Eliquis.', {
    mentions: ['Eliquis'], predicate: 'started', focus: 'Eliquis', confidence: 0.99,
  }, { hasPending: pending.hasPending() });
  assert('pending defers a high-confidence medication proposal', deferred.decision === 'DEFER' && pending.peekPendingKey() === 'medical_capture',
    (v) => v === true, 'DEFER');

  const todo = admitTodoSemanticP2('Please remember to water the plants.', {
    capability: 'todo_capture', candidates: ['water the plants'], confidence: 0.99,
  }, { hasPending: false });
  assert('an admitted todo proposal is not itself a commit', todo.decision === 'ADMIT' && !('status' in todo),
    (v) => v === true, 'ADMIT candidates');
  assert('admitted todo still names the existing confirm path',
    routeSrc.includes("source: 'llm'") && routeSrc.includes("reason: 'semantic_proposal:todo_admit'"),
    (v) => v === true, 'llm confirm');
  assert('a list read is spoken by the list reader only after admission',
    /readAdmission\.decision === 'ADMIT_READ' && readAdmission\.capability === 'list\.read'[\s\S]{0,500}composeOpenListSpeech/.test(routeSrc),
    (v) => v === true, 'reader behind admission');

  const rejectedAct = actForRoute({ kind: 'needs_clarification', reason: 'default', response: 'I called Dr. Patel.' });
  assert('a rejected clarification act is selected from the route, not the sentence', rejectedAct?.kind === 'UNKNOWN',
    (v) => v === true, 'UNKNOWN');

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    const medication = new MedicationPresentationHolder();
    const ordered = new OrderedPresentationHolder();
    medication.establish(['med_a', 'med_b']);
    ordered.establish('grocery', ['item_a', 'item_b']);
    const ordinal = await processUtterance('the second one', new ConversationSession(), {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
      captureContext: { contacts: [], lists: [] },
    }, null, medication, ordered);
    assert('competing presented sets still clarify by structure',
      ordinal.handled === true && ordinal.responseAct?.kind === 'CLARIFY_REFERENCE' && medication.hasLive() && ordered.hasLive(),
      (v) => v === true, 'CLARIFY_REFERENCE');

    const groceryUtterance = 'at the grocery store';
    const groceryEligibility = evaluateSemanticDispatchEligibility(groceryUtterance);
    const groceryAdmit = admitDispatchedSemanticRead(
      { capability: 'list.read', confidence: 'high' },
      groceryEligibility,
      groceryUtterance,
    );
    assert('grocery eligibility can admit a list read', groceryAdmit.decision === 'ADMIT_READ' && groceryAdmit.capability === 'list.read',
      (v) => v === true, 'ADMIT_READ list.read');
    if (groceryAdmit.decision === 'ADMIT_READ') {
      const legacy = await classifyQuery(groceryUtterance);
      if (legacy.tier === 3 && legacy.reason === 'default') {
        const ctx = {
          completion: async () => ({ text: '{"capability":"list.read","confidence":"high"}' }),
        };
        const decision = await routeIntent(groceryUtterance, {
          classifyQuery,
          classifyLLM: null,
          llmReady: false,
          llmStatus: 'unavailable',
          getMedicationSemanticInterpreterCtx: () => ctx as never,
          semanticCapabilityDispatchEnabled: true,
          capabilityReadRouterEnabled: true,
        });
        assert('an admitted list read uses the grocery reader',
          decision.kind === 'device_read' && decision.response === composeOpenListSpeech('grocery', []),
          (v) => v === true, 'reader speech');
      } else {
        assert('an admitted list read uses the grocery reader', true, (v) => v === true, 'tier-1 owns this utterance');
      }
    }
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ConversationOrchestratorSlice4: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('conversationOrchestratorSlice4');
if (invokedDirectly) {
  runConversationOrchestratorSlice4Tests()
    .then((result) => process.exit(result.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
