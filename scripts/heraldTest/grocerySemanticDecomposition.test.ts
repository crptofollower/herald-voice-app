// scripts/heraldTest/grocerySemanticDecomposition.test.ts
// Grocery Semantic Decomposition V1 — P1 decomposition + P2 confirmation.
// Semantic classes, not founder-specific wording. Production flags are ON;
// GSD12 still injects grocery OFF.

import Database from 'better-sqlite3';
import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import {
  parseGrocerySemanticProposal,
  admitGrocerySemanticP1,
  admitGrocerySemanticP2,
  groundGroceryCandidates,
  formatGroceryCaptureConfirmPrompt,
  generateGrocerySemanticProposal,
  type GrocerySemanticProposal,
} from '../../src/routing/grocerySemanticDecomposition.ts';
import { GROCERY_SEMANTIC_DECOMPOSITION_ENABLED } from '../../src/constants/features.ts';
import { CAPABILITY_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/capabilityRouting.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function grocerySet(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'grocery' AND li.checked = 0`,
  ).all() as { body: string }[])
    .map((r) => r.body.trim().toLowerCase())
    .sort();
}

function proposal(over: Partial<GrocerySemanticProposal> = {}): GrocerySemanticProposal {
  return {
    capability: 'grocery_capture',
    candidates: ['milk', 'eggs', 'bread'],
    confidence: 0.92,
    ...over,
  };
}

function fakeCtx(p: GrocerySemanticProposal | string) {
  const content = typeof p === 'string' ? p : JSON.stringify(p);
  return {
    completion: async (opts?: { messages?: Array<{ content?: string }> }) => {
      const sys = String(opts?.messages?.[0]?.content ?? '');
      if (sys === CAPABILITY_PROPOSAL_SYSTEM_PROMPT) {
        return { content: '{"capability":"grocery.capture","confidence":"high"}' };
      }
      return { content };
    },
  } as any;
}

function enabledDeps(
  harness: ReturnType<typeof openJourneyDb>,
  ctx: ReturnType<typeof fakeCtx> | null,
) {
  return {
    ...harness.deps,
    grocerySemanticDecompositionEnabled: true,
    getMedicationSemanticInterpreterCtx: ctx ? () => ctx : () => null,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
  };
}

export async function runGrocerySemanticDecompositionTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  const setEq = (want: string[]) => (v: unknown) =>
    Array.isArray(v) && JSON.stringify(v) === JSON.stringify([...want].sort());

  console.log(`\n${BOLD}-- Grocery Semantic Decomposition V1 --${RESET}\n`);

  assert('FLAG default is ON', GROCERY_SEMANTIC_DECOMPOSITION_ENABLED, (v) => v === true, 'true');

  {
    const p = parseGrocerySemanticProposal('{"capability":"grocery_capture","candidates":["milk"],"confidence":0.8}');
    assert('PARSE1 well-formed proposal accepted', p, (v) => !!v && (v as GrocerySemanticProposal).candidates[0] === 'milk', 'parsed milk');
  }
  {
    const p = parseGrocerySemanticProposal('{"capability":"grocery","candidates":["milk"],"confidence":0.8}');
    assert('PARSE2 unknown capability rejected', p, (v) => v === null, 'null');
  }
  {
    const p = parseGrocerySemanticProposal('{"capability":"grocery_capture","candidates":["milk"],"confidence":2}');
    assert('PARSE3 out-of-range confidence rejected', p, (v) => v === null, 'null');
  }

  {
    const raw = 'add milk eggs bread to my grocery list';
    const grounded = groundGroceryCandidates(raw, ['milk', 'eggs', 'bread']);
    assert('GROUND1 punctuation-free spans ground', grounded, (v) => Array.isArray(v) && v.length === 3, '3 spans');
    const hall = groundGroceryCandidates(raw, ['milk', 'saffron']);
    assert('GROUND2 hallucinated candidate rejects whole set', hall, (v) => v === null, 'null');
  }

  {
    const d = admitGrocerySemanticP2('We need milk eggs and bread.', proposal(), { hasPending: false });
    assert('ADMIT-P2 natural need admits when grounded', d.decision, (v) => v === 'ADMIT', 'ADMIT');
  }
  {
    const d = admitGrocerySemanticP2('I bought milk yesterday.', proposal({ candidates: ['milk'] }), { hasPending: false });
    assert('ADMIT-P2 past purchase refused', d.decision, (v) => v === 'REJECT', 'REJECT');
  }
  {
    const d = admitGrocerySemanticP2('Milk is expensive.', proposal({ capability: 'uncertain', candidates: ['milk'] }), { hasPending: false });
    assert('ADMIT-P2 uncertain capability does not admit', d.decision, (v) => v !== 'ADMIT', 'not ADMIT');
  }
  {
    const d = admitGrocerySemanticP1('add milk eggs bread to my grocery list', proposal({ capability: 'not_grocery_capture' }));
    assert('ADMIT-P1 non-grocery capability defers to deterministic items', d.decision, (v) => v === 'DEFER', 'DEFER');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal()));
    const t1 = await processUtterance(normalizeInput('add milk eggs bread to my grocery list'), harness.session, deps);
    assert('GSD1 P1 punctuation-free decomposes to three items', grocerySet(harness.db), setEq(['milk', 'eggs', 'bread']), '["bread","eggs","milk"]');
    assert('GSD1 P1 commits immediately (no confirmation pending)', t1.commits.some((c) => c.status === 'pending'), (v) => v === false, 'no pending');
    assert('GSD1 P1 is not You-last-saw / medical', t1.responseText, (v) => typeof v === 'string' && /grocery list/i.test(v), 'grocery ack');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal()));
    await processUtterance(normalizeInput('put milk, eggs, and bread on my grocery list'), harness.session, deps);
    assert('GSD2 P1 punctuated add still three items', grocerySet(harness.db), setEq(['milk', 'eggs', 'bread']), '["bread","eggs","milk"]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal()));
    const t1 = await processUtterance(normalizeInput('We need milk eggs and bread.'), harness.session, deps);
    assert('GSD3 P2 does not persist before confirmation', grocerySet(harness.db), setEq([]), '[]');
    assert('GSD3 P2 confirmation required', t1.commits.some((c) => c.status === 'pending'), (v) => v === true, 'pending');
    assert('GSD3 P2 prompt names items and asks to add', t1.responseText,
      (v) => typeof v === 'string' && /milk/i.test(v) && /eggs/i.test(v) && /bread/i.test(v) && /grocery list/i.test(v) && /want me to add/i.test(v),
      formatGroceryCaptureConfirmPrompt(['milk', 'eggs', 'bread']));
    const t2 = await processUtterance('yes', harness.session, deps);
    assert('GSD3 P2 yes persists grounded set', grocerySet(harness.db), setEq(['milk', 'eggs', 'bread']), '["bread","eggs","milk"]');
    assert('GSD3 P2 yes commit-truth ack', t2.commits.some((c) => c.status === 'committed'), (v) => v === true, 'committed');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ candidates: ['milk', 'eggs'] })));
    await processUtterance(normalizeInput('We still need milk and eggs.'), harness.session, deps);
    assert('GSD3b unseen P2 phrasing still confirmation-gated', grocerySet(harness.db), setEq([]), '[]');
    await processUtterance('yes', harness.session, deps);
    assert('GSD3b unseen P2 phrasing persists after yes', grocerySet(harness.db), setEq(['milk', 'eggs']), '["eggs","milk"]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal()));
    await processUtterance(normalizeInput('We need milk eggs and bread.'), harness.session, deps);
    await processUtterance('no', harness.session, deps);
    assert('GSD4 P2 no persists nothing', grocerySet(harness.db), setEq([]), '[]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ capability: 'not_grocery_capture', candidates: ['milk'] })));
    const t1 = await processUtterance(normalizeInput('We were talking about milk at dinner.'), harness.session, deps);
    assert('GSD5 narrative mention does not persist', grocerySet(harness.db), setEq([]), '[]');
    assert('GSD5 narrative is not grocery confirmation', (t1 as { commits?: { status: string }[] }).commits?.some((c) => c.status === 'pending') ?? false, (v) => v === false, 'no pending');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ candidates: ['milk'] })));
    await processUtterance(normalizeInput('I bought milk yesterday.'), harness.session, deps);
    assert('GSD6 past grocery event does not persist', grocerySet(harness.db), setEq([]), '[]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ capability: 'uncertain', candidates: ['milk'] })));
    await processUtterance(normalizeInput('Maybe we should get milk.'), harness.session, deps);
    assert('GSD7 uncertain proposal does not persist', grocerySet(harness.db), setEq([]), '[]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ candidates: ['milk', 'saffron'] })));
    await processUtterance(normalizeInput('We need milk.'), harness.session, deps);
    assert('GSD8 hallucinated candidate never persists', grocerySet(harness.db), setEq([]), '[]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ candidates: ['peanut butter and jelly'] })));
    await processUtterance(normalizeInput('add peanut butter and jelly to my grocery list'), harness.session, deps);
    assert('GSD9 compound item remains one candidate', grocerySet(harness.db), setEq(['peanut butter and jelly']), '["peanut butter and jelly"]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal()));
    await processUtterance(normalizeInput('add milk eggs and bread to my grocery list'), harness.session, deps);
    assert('GSD10 STT-like punctuation-free P1 multi-item', grocerySet(harness.db), setEq(['milk', 'eggs', 'bread']), '["bread","eggs","milk"]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, null);
    await processUtterance(normalizeInput('add milk eggs bread to my grocery list'), harness.session, deps);
    assert('GSD11 interpreter unavailable keeps deterministic blob', grocerySet(harness.db), setEq(['milk eggs bread']), '["milk eggs bread"]');
  }

  {
    const harness = openJourneyDb();
    const wired = {
      ...harness.deps,
      grocerySemanticDecompositionEnabled: false,
      getMedicationSemanticInterpreterCtx: () => fakeCtx(proposal()),
    };
    await processUtterance(normalizeInput('We need milk eggs and bread.'), harness.session, wired);
    assert('GSD12 flag OFF does not admit unframed need', grocerySet(harness.db), setEq([]), '[]');
  }

  {
    const r = await generateGrocerySemanticProposal('We need milk.', () => null);
    assert('GSD11b generate unavailable without ctx', r.status, (v) => v === 'unavailable', 'unavailable');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}GrocerySemanticDecomposition: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('grocerySemanticDecomposition.test.ts')) {
  runGrocerySemanticDecompositionTests().catch(console.error);
}
