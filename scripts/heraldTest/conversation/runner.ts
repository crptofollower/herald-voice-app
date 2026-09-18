import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureGitMeta,
  openJourneyDb,
  requiredTurnEvidencePresent,
  runJourneyTurn,
  type ContractResult,
  type DbDiff,
  type TurnRecord,
} from '../journeyHarness.ts';
import { bodies, countAuthoritativeDelta, isExactZeroDelta } from './delta.ts';
import {
  ENCODED_SCENARIOS,
  STAGE1_SCHEMA,
  UNREACHABLE_SCENARIOS,
  type EncodedScenario,
  type TurnExpectation,
} from './scenarios.ts';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function c(id: string, ok: boolean, evidence: string): ContractResult {
  return { id, description: id, verdict: ok ? 'PASS' : 'FAIL', evidence };
}

function sameBodies(got: string[], expected: string[]): boolean {
  return JSON.stringify([...got].sort()) === JSON.stringify([...expected].sort());
}

function gradeTurn(rec: TurnRecord, expect: TurnExpectation): ContractResult[] {
  const out: ContractResult[] = [];
  const gradeable = requiredTurnEvidencePresent(rec);
  out.push(c('evidence', gradeable, `response=${JSON.stringify(rec.response)}`));
  if (!gradeable) return out;

  out.push(c(
    'pending_key_after',
    rec.pending_key_after === expect.pending_key_after,
    `got=${JSON.stringify(rec.pending_key_after)} expected=${JSON.stringify(expect.pending_key_after)}`,
  ));
  if (expect.pending_key_before !== undefined) {
    out.push(c(
      'pending_key_before',
      rec.pending_key_before === expect.pending_key_before,
      `got=${JSON.stringify(rec.pending_key_before)} expected=${JSON.stringify(expect.pending_key_before)}`,
    ));
  }
  if (expect.route_source !== undefined) {
    out.push(c(
      'route_source',
      rec.route_source === expect.route_source,
      `got=${JSON.stringify(rec.route_source)} expected=${JSON.stringify(expect.route_source)}`,
    ));
  }
  if (expect.commit_statuses) {
    out.push(c(
      'commit_statuses',
      JSON.stringify(rec.commit_statuses) === JSON.stringify(expect.commit_statuses),
      `got=${JSON.stringify(rec.commit_statuses)} expected=${JSON.stringify(expect.commit_statuses)}`,
    ));
  }
  if (expect.commit_pending_keys) {
    out.push(c(
      'commit_pending_keys',
      JSON.stringify(rec.commit_pending_keys) === JSON.stringify(expect.commit_pending_keys),
      `got=${JSON.stringify(rec.commit_pending_keys)} expected=${JSON.stringify(expect.commit_pending_keys)}`,
    ));
  }
  if (expect.zero_delta) {
    out.push(c('exact_zero_delta', isExactZeroDelta(rec.db_diff), JSON.stringify(countAuthoritativeDelta(rec.db_diff))));
  } else {
    out.push(c(
      'authoritative_delta_present',
      !isExactZeroDelta(rec.db_diff),
      JSON.stringify(countAuthoritativeDelta(rec.db_diff)),
    ));
  }
  if (expect.lists_added) {
    const names = rec.db_diff.lists_added.map((l) => l.name);
    out.push(c(
      'lists_added',
      JSON.stringify([...names].sort()) === JSON.stringify([...expect.lists_added].sort()),
      `got=${JSON.stringify(names)} expected=${JSON.stringify(expect.lists_added)}`,
    ));
  }
  if (expect.items_added) {
    const got = rec.db_diff.list_items_added.map((i) => `${i.list_name}:${i.body}`).sort();
    const exp = expect.items_added.map((i) => `${i.list_name}:${i.body}`).sort();
    out.push(c('list_items_added', JSON.stringify(got) === JSON.stringify(exp), `got=${JSON.stringify(got)} expected=${JSON.stringify(exp)}`));
  }
  if (expect.items_changed !== undefined) {
    out.push(c(
      'list_items_changed',
      rec.db_diff.list_items_changed.length === expect.items_changed,
      `got=${rec.db_diff.list_items_changed.length}`,
    ));
  }
  if (expect.open_todos) {
    out.push(c('open_todos', sameBodies(bodies(rec.db_after.list_items, 'todos'), expect.open_todos),
      JSON.stringify(bodies(rec.db_after.list_items, 'todos'))));
  }
  if (expect.open_grocery) {
    out.push(c('open_grocery', sameBodies(bodies(rec.db_after.list_items, 'grocery'), expect.open_grocery),
      JSON.stringify(bodies(rec.db_after.list_items, 'grocery'))));
  }
  if (expect.open_todos_count !== undefined) {
    out.push(c('open_todos_count', bodies(rec.db_after.list_items, 'todos').length === expect.open_todos_count,
      String(bodies(rec.db_after.list_items, 'todos').length)));
  }
  if (expect.open_grocery_count !== undefined) {
    out.push(c('open_grocery_count', bodies(rec.db_after.list_items, 'grocery').length === expect.open_grocery_count,
      String(bodies(rec.db_after.list_items, 'grocery').length)));
  }
  const text = rec.response ?? '';
  for (const needle of expect.response_includes ?? []) {
    out.push(c(`response_includes:${needle}`, text.includes(needle), JSON.stringify(text)));
  }
  for (const needle of expect.response_excludes ?? []) {
    out.push(c(`response_excludes:${needle}`, !text.includes(needle), JSON.stringify(text)));
  }
  if (expect.capability === 'todo_add') {
    out.push(c('not_contact_call', rec.pending_key_after !== 'contact_call' && rec.route_reason !== 'contact_call',
      `reason=${rec.route_reason} pending=${rec.pending_key_after}`));
  }
  return out;
}

async function runScenario(scenario: EncodedScenario) {
  const { db, session, deps, orderedPresentation } = openJourneyDb();
  const turns: TurnRecord[] = [];
  for (let i = 0; i < scenario.turns.length; i++) {
    const expect = scenario.turns[i];
    const rec = await runJourneyTurn(db, session, deps, i + 1, expect.input, orderedPresentation);
    rec.contracts = gradeTurn(rec, expect);
    rec.result = rec.contracts.some((x) => x.verdict !== 'PASS') ? 'FAIL' : 'PASS';
    turns.push(rec);
  }
  const failed = turns.flatMap((t) => t.contracts.filter((x) => x.verdict === 'FAIL'));
  return {
    id: scenario.id,
    title: scenario.title,
    claimed_path: scenario.claimed_path,
    status: (failed.length ? 'FAIL' : 'PASS') as 'FAIL' | 'PASS',
    turns: turns.map((t) => ({
      turn: t.turn,
      input: t.input,
      route_source: t.route_source,
      route_kind: t.route_kind,
      route_reason: t.route_reason,
      pending_key_before: t.pending_key_before,
      pending_key_after: t.pending_key_after,
      commit_statuses: t.commit_statuses,
      commit_pending_keys: t.commit_pending_keys,
      response: t.response,
      db_delta: countAuthoritativeDelta(t.db_diff),
      exact_zero_delta: isExactZeroDelta(t.db_diff),
      list_items_after: t.db_after.list_items.map((i) => ({
        list_name: i.list_name,
        body: i.body,
        checked: i.checked,
        removed_at: i.removed_at,
      })),
      lists_after: t.db_after.lists.map((l) => ({ name: l.name })),
      contracts: t.contracts,
      result: t.result,
    })),
    failures: failed.map((f) => ({ id: f.id, evidence: f.evidence })),
  };
}

export async function runStage1ConversationRunner() {
  const git = captureGitMeta(process.cwd());
  const results = [];
  let passed = 0;
  let failed = 0;

  console.log(`\n${BOLD}Herald Stage 1 conversation runner${RESET}`);
  console.log(`${DIM}seam: normalizeInput → processUtterance → ConversationSession + DOMAIN_WRITERS${RESET}`);
  console.log(`${DIM}classifier: production classifyQuery; classifyLLM empty stub; llmReady=false${RESET}\n`);

  for (const scenario of ENCODED_SCENARIOS) {
    const result = await runScenario(scenario);
    results.push(result);
    if (result.status === 'PASS') {
      passed++;
      console.log(`${GREEN}✓ PASS${RESET}  ${scenario.id}`);
    } else {
      failed++;
      console.log(`${RED}✗ FAIL${RESET}  ${scenario.id}`);
      for (const f of result.failures) console.log(`       ${f.id}: ${f.evidence}`);
    }
    for (const t of result.turns) {
      console.log(`${DIM}       T${t.turn} source=${t.route_source} pending=${t.pending_key_after} zero=${t.exact_zero_delta} commits=${JSON.stringify(t.commit_statuses)}${RESET}`);
    }
  }

  console.log(`\n${BOLD}Unreachable (probed, not encoded as passing claims)${RESET}`);
  for (const u of UNREACHABLE_SCENARIOS) {
    console.log(`${DIM}  - ${u.id}: ${u.observed}${RESET}`);
  }

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evidence');
  const artifactPath = path.join(dir, 'stage1.json');
  const packet = {
    schema_version: STAGE1_SCHEMA,
    git,
    production_seam: 'normalizeInput → processUtterance → ConversationSession + DOMAIN_WRITERS via journeyHarness; classifyQuery live; classifyLLM stub {status:ok,intents:[]}; llmReady=false',
    classifier_stub: { llmReady: false, classifyLLM: 'ok_empty_intents' },
    encoded: results,
    unreachable: UNREACHABLE_SCENARIOS,
    summary: {
      encoded_passed: passed,
      encoded_failed: failed,
      encoded_total: ENCODED_SCENARIOS.length,
      unreachable: UNREACHABLE_SCENARIOS.length,
    },
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`${DIM}  optional evidence not written (${reason})${RESET}`);
  }

  const failures = results
    .filter((r) => r.status === 'FAIL')
    .map((r) => ({
      label: r.id,
      expected: 'PASS',
      got: r.failures.map((f) => `${f.id}: ${f.evidence}`).join('; ') || 'scenario failed',
    }));

  const total = passed + failed;
  console.log(`\n${BOLD}Stage1 conversation: ${passed}/${total} encoded passed${failed ? ` — ${RED}${failed} FAILED${RESET}` : ` — ${GREEN}all encoded green${RESET}`}${RESET}`);
  console.log(`  evidence: ${artifactPath}`);
  return { passed, failed, total, artifactPath, packet, failures };
}

export type { DbDiff };
