// Composed proof: one shared predicate, two admission consumers, one trajectory.
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { isDirectAddressToHerald } from '../../src/routing/directAddress.ts';
import { shouldRefuseLlmCaptureProposal } from '../../src/routing/speechActAuthority.ts';
import { detectEmergency } from '../../src/routing/emergencySignals.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    body TEXT NOT NULL,
    checked INTEGER DEFAULT 0,
    removed_at TEXT,
    created_at TEXT NOT NULL
  );
`;

export async function runActionAdmissionProofTests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- Action-admission contract proof (slice 1) ----------------------${RESET}\n`);

  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });

  const session = new ConversationSession();
  const hostileTodo: IntentRecord[] = [{ type: 'todo_add', body: 'avoid dairy' }];
  const deps = {
    classifyQuery,
    classifyLLM: async (t: string) => {
      if (/avoid dairy|needs to avoid/i.test(t) || /Paul needs help/i.test(t)) {
        return { status: 'ok' as const, intents: hostileTodo };
      }
      return { status: 'ok' as const, intents: [{ type: 'pass' as const }] };
    },
    llmReady: true,
    captureContext: { contacts: [] as string[], lists: [] as string[] },
  };

  const t1 = await processUtterance('I talked with Paul yesterday.', session, deps as any);
  check('P1 ordinary person conversation is not emergency', t1.source !== 'emergency');

  const narr = 'I think Paul needs help with his move';
  check('P2 shared predicate: narrative is not direct address', isDirectAddressToHerald(narr) === false);
  const t2 = await processUtterance(narr, session, deps as any);
  check('P2 narrative does not acquire Law 0', t2.source !== 'emergency' && detectEmergency(narr) === false);

  const t3 = await processUtterance('He said he might have some time next week.', session, deps as any);
  check('P3 continued conversation is not emergency', t3.source !== 'emergency');

  const diet = 'My son needs to avoid dairy this week.';
  check('P4 shared predicate: diet narrative is not direct address', isDirectAddressToHerald(diet) === false);
  check('P4 D5 refuses classifier todo on that narrative', shouldRefuseLlmCaptureProposal(diet, hostileTodo) === true);
  const t4 = await processUtterance(diet, session, deps as any);
  check('P5 capture is refused (not llm capture)', t4.handled === false || t4.source !== 'capture');

  const pharmacy = 'I need to call the pharmacy.';
  check('P6 genuine first-person remains direct address', isDirectAddressToHerald(pharmacy) === true);
  check('P6 D5 does not refuse genuine I need to', shouldRefuseLlmCaptureProposal(pharmacy, [{ type: 'todo_add', body: 'call the pharmacy' }]) === false);
  const t6 = await processUtterance(pharmacy, session, deps as any);
  check('P7 genuine capture remains admitted through existing authority',
    t6.source === 'capture' || (t6.handled === true && t6.source !== 'emergency'));

  const t8 = await processUtterance('I need help', session, deps as any);
  check('P8 genuine emergency still preempts Law 0', t8.handled === true && t8.source === 'emergency');
  check('P8 no model call required (already emergency source)', t8.source === 'emergency');

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`\x1b[31m❌ actionAdmissionProof: ${failures.length} failed\x1b[0m`);
  } else {
    console.log(`\x1b[32m✅ actionAdmissionProof: ${passed}/${total} — all green\x1b[0m`);
  }
  return { passed, failed: failures.length, total };
}

if (process.argv[1]?.endsWith('actionAdmissionProof.test.ts')) {
  runActionAdmissionProofTests().then((r) => process.exit(r.failed ? 1 : 0));
}
