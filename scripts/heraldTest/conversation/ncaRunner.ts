/**
 * Natural Conversation Acceptance Corpus V1 runner.
 * Measurement on the existing journey seam:
 *   normalizeInput → processUtterance → ConversationSession + DOMAIN_WRITERS
 * ChatScreen recap / canned / Linking.openURL are not this seam (labeled).
 * UNSUPPORTED does not fail the gate. Continuity mustPass regressions do.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { processUtterance } from '../../../src/routing/processUtterance.ts';
import { normalizeInput } from '../../../src/utils/normalizeInput.ts';
import { EPHEMERAL_CLARIFY_REPLY } from '../../../src/utils/ephemeralSeam.ts';
import { classifyQuery } from '../../../src/routing/tierRouter.ts';
import { dispatchAction, type DispatchDeps } from '../../../src/screens/chat/dispatch.ts';
import type { ConversationSession } from '../../../src/routing/conversationSession.ts';
import {
  captureGitMeta,
  describeOutcome,
  diffMedications,
  openJourneyDb,
  snapshotMedications,
  type DbDiff,
} from '../journeyHarness.ts';
import { countAuthoritativeDelta as countDelta, isExactZeroDelta as zeroDelta } from './delta.ts';
import { NCA_V1_SCHEMA, NCA_V1_SCENARIOS, type NcaClass, type NcaScenario } from './nca.v1.scenarios.ts';
import { DiscourseContinuityHolder } from '../../../src/routing/discourseContinuity.ts';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

type SocialSnap = {
  contacts: Array<{ name: string; relationship: string | null; phone: string | null; address: string | null }>;
  facts: Array<{ fact: string; category: string | null }>;
  medical_contacts: Array<{ name: string | null; specialty: string | null }>;
};

function snapshotSocial(db: Database.Database): SocialSnap {
  const q = <T>(sql: string): T[] => {
    try { return db.prepare(sql).all() as T[]; } catch { return []; }
  };
  return {
    contacts: q('SELECT name, relationship, phone, address FROM contacts WHERE removed_at IS NULL'),
    facts: q('SELECT fact, category FROM facts'),
    medical_contacts: q('SELECT name, specialty FROM medical_contacts WHERE removed_at IS NULL'),
  };
}

function makeDispatchDeps(session: ConversationSession, openURLs: string[], messages: string[]): DispatchDeps {
  return {
    session,
    addMessage: (m) => { if (m.role === 'assistant') messages.push(m.content); },
    speak: () => {},
    setInputText: () => {},
    sendingRef: { current: false },
    generateId: (prefix) => `${prefix}_nca`,
    llmStatus: 'ready',
    getCtx: () => null,
    resolveContactPhone: async () => null,
    handleCalendarAction: async () => {},
    handleMapsAction: async () => {},
    launchAndroidTimer: async () => false,
    handleLaunchActionRef: { current: null },
    pendingContactCollectRef: { current: null },
    platformOS: 'android',
    openURL: async (url) => { openURLs.push(url); },
  };
}

async function applyDeviceActionIfNeeded(
  input: string,
  session: ConversationSession,
  openURLs: string[],
  messages: string[],
): Promise<boolean> {
  const decision = await classifyQuery(normalizeInput(input));
  const intent = decision.actionIntent;
  if (!intent) return false;
  if (intent.type !== 'sms' && intent.type !== 'call') return false;
  await dispatchAction(intent, input, makeDispatchDeps(session, openURLs, messages));
  return true;
}

function seedDb(db: Database.Database, scenario: NcaScenario): void {
  const now = new Date().toISOString();
  for (const c of scenario.seed?.contacts ?? []) {
    db.prepare(
      `INSERT INTO contacts (id, name, relationship, phone, email, birthday, importance, created_at, updated_at, address, is_emergency)
       VALUES (?, ?, ?, ?, NULL, NULL, 5, ?, ?, NULL, 0)`,
    ).run(c.id, c.name, c.relationship ?? null, c.phone ?? null, now, now);
  }
  for (const ev of scenario.seed?.calendar ?? []) {
    db.prepare(
      `INSERT INTO calendar_cache (id, title, start_ms, end_ms, all_day, notes, cached_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?)`,
    ).run(ev.id, ev.title, ev.start_ms, ev.end_ms, now);
  }
}

function flattenText(rec: {
  response: string | null;
  route_kind: string | null;
  route_reason: string | null;
  device_action: string | null;
}): string {
  return [rec.response, rec.route_kind, rec.route_reason, rec.device_action].filter(Boolean).join(' | ');
}

type TurnObs = {
  turn: number;
  input: string;
  handled: boolean;
  source: string | null;
  route_kind: string | null;
  route_reason: string | null;
  pending_key_before: string | null;
  pending_key_after: string | null;
  commit_statuses: string[];
  commit_pending_keys: Array<string | null>;
  response: string | null;
  /** CODE: processUtterance responseText or device_read. ChatScreen canned is not here. */
  realized_response_seam: string | null;
  realization_note: string;
  device_action: string | null;
  capability_urls: string[];
  db_delta: ReturnType<typeof countDelta>;
  exact_zero_delta: boolean;
  list_items_after: Array<{ list_name: string; body: string }>;
  medications_after: Array<{ name: string; notes: string | null; is_active: number }>;
  medical_records_after: Array<{ doctor_name: string | null; notes: string | null; visit_outcome: string | null }>;
  contacts_after: SocialSnap['contacts'];
  facts_after: SocialSnap['facts'];
  flags: string[];
  classification: NcaClass;
  classification_why: string;
  evidence_layer: 'CODE';
};

const START_OVER = /start that one over|start over/i;
const CHATBOT_TAIL = /if you need anything else|let me know if i can help|is there anything else i can/i;
const LYMPHOMA_FACT = /\bhas lymphoma\b|\byou have lymphoma\b|\bdiagnosed with lymphoma\b/i;
const CANCER_FACT = /\byou have cancer\b|\bhas cancer\b|\bit'?s cancer\b|\bthis is cancer\b/i;
const TAKING_XYZ = /\b(taking|on|currently taking)\s+xyz\b/i;

function trustFlags(obs: TurnObs): string[] {
  const flags: string[] = [];
  const blob = `${flattenText(obs)} ${JSON.stringify(obs.medical_records_after)} ${JSON.stringify(obs.medications_after)}`;
  if (START_OVER.test(obs.response ?? '')) flags.push('start_over_language');
  if (CHATBOT_TAIL.test(obs.response ?? '')) flags.push('chatbot_tail');
  if (LYMPHOMA_FACT.test(blob)) flags.push('lymphoma_as_fact');
  if (CANCER_FACT.test(blob)) flags.push('cancer_as_fact');
  if (TAKING_XYZ.test(blob)) flags.push('prescribed_as_taking');
  for (const rec of obs.medical_records_after) {
    const n = `${rec.notes ?? ''} ${rec.visit_outcome ?? ''}`;
    if (/\blymphoma\b/i.test(n) && !/\bmight\b|\blooks like\b|\bpossible\b/i.test(n)) {
      flags.push('lymphoma_record_unhedged');
    }
  }
  for (const med of obs.medications_after) {
    if (/xyz/i.test(med.name) && med.is_active === 1) flags.push('xyz_active_medication');
  }
  return flags;
}

function classifyTurn(scenario: NcaScenario, obs: TurnObs): { cls: NcaClass; why: string } {
  const flags = trustFlags(obs);
  obs.flags = flags;
  if (flags.some((f) => f.startsWith('lymphoma') || f.startsWith('cancer') || f === 'prescribed_as_taking' || f === 'xyz_active_medication' || f === 'lymphoma_record_unhedged')) {
    return { cls: 'TRUST_FAILURE', why: flags.join(',') };
  }

  if (scenario.mustPass) {
    if (flags.includes('start_over_language')) {
      return { cls: 'WRONG', why: 'start-over language on Continuity V1 path' };
    }
  }

  const items = obs.list_items_after.map((i) => `${i.list_name}:${i.body.toLowerCase()}`);
  const text = flattenText(obs);

  if (scenario.id.startsWith('nca.f6.continuity_paul')) {
    if (obs.turn === 3 && obs.pending_key_after && /didn't catch|which one/i.test(obs.response ?? '')) {
      return { cls: 'PASS', why: 'first-miss hold' };
    }
    if (obs.turn === 4 && /did you mean paul cioffre/i.test(obs.response ?? '')) {
      return { cls: 'PASS', why: 'spelling proposed; not sent' };
    }
    if (obs.turn === 5 && (obs.commit_statuses.includes('committed') || obs.capability_urls.some((u) => /sms:5553010001/i.test(u) && /home at 8/i.test(decodeURIComponent(u))))) {
      return { cls: 'PASS', why: 'YES committed retained SMS' };
    }
    if (obs.turn <= 2 && (obs.pending_key_after || obs.commit_statuses.includes('pending'))) {
      return { cls: 'PASS', why: 'clarification pending retained' };
    }
  }

  if (scenario.id === 'nca.f6.call_spelling_hold') {
    if (obs.turn === 1 && obs.pending_key_after === 'contact_call') {
      return { cls: 'PASS', why: 'CALL pending finite set' };
    }
    if (obs.turn === 2 && obs.pending_key_after === 'contact_call' && /didn't catch/i.test(obs.response ?? '')) {
      return { cls: 'PASS', why: 'miss holds contact_call' };
    }
    if (obs.turn === 3 && /calling paul cioffre/i.test(obs.response ?? '')) {
      return { cls: 'PASS', why: 'typed fragment completed CALL' };
    }
  }

  if (scenario.family === 1 && obs.turn >= 2 && obs.pending_key_after === 'family_capture') {
    return { cls: 'WRONG', why: 'follow-up absorbed as family_capture instead of answering stored preference' };
  }
  if (scenario.family === 1 && /come back to that/i.test(obs.response ?? '')) {
    return { cls: 'WRONG', why: 'pending release destroyed the everyday-life follow-up journey' };
  }
  if (scenario.family === 2 && obs.turn >= 2 && obs.source === 'pending_resume' && /not sure i'm following|come back to that/i.test(obs.response ?? '')) {
    return { cls: 'WRONG', why: 'medical pending absorbed a recall follow-up' };
  }
  if (scenario.id.startsWith('nca.f5') && obs.turn === 1 && obs.device_action && /app_open/i.test(obs.device_action) && !/16205|Hickory/i.test(obs.device_action)) {
    return { cls: 'WRONG', why: 'Maps opened without the spoken street address' };
  }

  if (scenario.family === 2) {
    if (/\blymphoma\b/i.test(obs.response ?? '') && !/\bmight\b|\blooks like\b|\bpossible\b|\bnot sure\b/i.test(obs.response ?? '')) {
      return { cls: 'TRUST_FAILURE', why: 'response restates lymphoma without hedge' };
    }
  }

  if (scenario.id === 'nca.f6.self_correction_grocery') {
    const bread = items.some((i) => i.includes('grocery:') && i.includes('bread'));
    const coffee = items.some((i) => i.includes('grocery:') && i.includes('coffee'));
    const eggs = items.some((i) => i.includes('grocery:') && i.includes('egg'));
    if (bread) return { cls: 'WRONG', why: `bread written after reversal: ${JSON.stringify(items)}` };
    if (coffee && eggs && !bread) return { cls: 'PASS', why: 'eggs+coffee kept, bread dropped' };
    if (eggs && !coffee) return { cls: 'WRONG', why: `wrote eggs but dropped coffee: ${JSON.stringify(items)}` };
    if (!obs.handled || obs.route_kind === 'needs_clarification') {
      return { cls: 'UNSUPPORTED', why: 'no grocery write; rambling reversal not captured' };
    }
  }

  if (scenario.id === 'nca.f6.interruption_return') {
    if (obs.turn === 2) {
      if (obs.pending_key_after === 'llm_confirm:list_add' && !/time/i.test(obs.response ?? '')) {
        return { cls: 'WRONG', why: 'grocery pending absorbed what-time' };
      }
      if (obs.route_kind === 'device_read' || /time/i.test(obs.response ?? '')) {
        return { cls: 'PASS', why: 'time read; pending not required for this measurement' };
      }
    }
  }

  if (scenario.id === 'nca.f3b.italy_inconsistent_date') {
    if (/november 4/i.test(obs.response ?? '') && /december 4/i.test(obs.response ?? '')) {
      return { cls: 'PASS', why: 'both dates surfaced' };
    }
    if (/november 4/i.test(obs.response ?? '') && !/december 4/i.test(obs.response ?? '')) {
      return { cls: 'WRONG', why: 'silently resolved to November 4' };
    }
    if (/december 4/i.test(obs.response ?? '') && obs.turn === 2 && !/not sure|which|unclear|contradict/i.test(obs.response ?? '')) {
      return { cls: 'WRONG', why: 'silently resolved a contradictory return date' };
    }
  }

  if (!obs.handled && obs.route_kind === 'needs_clarification') {
    return { cls: 'UNSUPPORTED', why: `needs_clarification reason=${obs.route_reason}; ChatScreen recap/canned not on this seam` };
  }
  if (!obs.handled && obs.route_kind === 'device_action') {
    return { cls: 'UNSUPPORTED', why: `device_action ${obs.device_action} proposed; Linking/ChatScreen fire not on this seam` };
  }
  if (!obs.handled && obs.route_kind === 'backend') {
    return { cls: 'UNSUPPORTED', why: `backend ${obs.route_reason}` };
  }

  if (obs.handled && !obs.exact_zero_delta) {
    return { cls: 'PASS', why: 'deterministic write/action on seam' };
  }
  if (obs.handled && obs.commit_statuses.includes('pending')) {
    return { cls: 'PASS', why: 'pending clarification armed' };
  }

  if (obs.response && /not sure i'm following/i.test(obs.response)) {
    return { cls: 'UNSUPPORTED', why: 'canned clarify on seam' };
  }

  return { cls: 'UNKNOWN', why: `handled=${obs.handled} kind=${obs.route_kind} pending=${obs.pending_key_after}` };
}

function classifyScenario(scenario: NcaScenario, turns: TurnObs[]): NcaClass {
  if (turns.some((t) => t.classification === 'TRUST_FAILURE')) return 'TRUST_FAILURE';
  if (scenario.mustPass) {
    if (turns.every((t) => t.classification === 'PASS')) return 'PASS';
    if (turns.some((t) => t.classification === 'WRONG' || t.classification === 'TRUST_FAILURE')) {
      return turns.find((t) => t.classification === 'TRUST_FAILURE')?.classification
        ?? 'WRONG';
    }
    return 'WRONG';
  }
  if (turns.some((t) => t.classification === 'WRONG')) return 'WRONG';
  if (turns.every((t) => t.classification === 'PASS')) return 'PASS';
  if (turns.some((t) => t.classification === 'PASS') && turns.every((t) => t.classification === 'PASS' || t.classification === 'UNSUPPORTED')) {
    return 'UNSUPPORTED';
  }
  if (turns.every((t) => t.classification === 'UNSUPPORTED')) return 'UNSUPPORTED';
  if (turns.some((t) => t.classification === 'UNKNOWN')) return 'UNKNOWN';
  return 'UNSUPPORTED';
}

async function runScenario(scenario: NcaScenario) {
  const { db, session, deps, orderedPresentation } = openJourneyDb();
  seedDb(db, scenario);
  const discourse = new DiscourseContinuityHolder();
  const turns: TurnObs[] = [];
  const openURLs: string[] = [];
  const spoken: string[] = [];
  for (let i = 0; i < scenario.turns.length; i++) {
    const input = scenario.turns[i];
    const pending_key_before = session.peekPendingKey();
    const db_before = snapshotMedications(db);
    let outcome = await processUtterance(
      normalizeInput(input),
      session,
      deps,
      null,
      null,
      orderedPresentation,
      null,
      null,
      discourse,
    );
    let described = describeOutcome(outcome);
    let device_action: string | null = null;
    let realization_note = 'CODE: processUtterance responseText / device_read only.';
    if (!outcome.handled) {
      const rd = outcome.routeDecision;
      if (rd.kind === 'device_action') {
        device_action = `${rd.actionIntent.type}:${JSON.stringify(rd.actionIntent)}`;
        realization_note = 'CODE: device_action proposed. ChatScreen Linking.openURL not executed on this seam.';
        if (rd.actionIntent.type === 'sms' || rd.actionIntent.type === 'call') {
          const before = spoken.length;
          await applyDeviceActionIfNeeded(input, session, openURLs, spoken);
          realization_note = 'CODE: processUtterance device_action then dispatchAction (ChatScreen SMS/CALL seam).';
          described = {
            ...described,
            route_kind: 'device_action+dispatch',
            route_source: 'dispatchAction',
            response: spoken.slice(before).join(' | ') || described.response,
            commit_statuses: session.hasPending() ? ['pending'] : (openURLs.length ? ['committed'] : described.commit_statuses),
            commit_pending_keys: session.hasPending() ? [session.peekPendingKey()] : described.commit_pending_keys,
          };
        }
      } else if (rd.kind === 'needs_clarification') {
        realization_note = `CODE: needs_clarification reason=${rd.reason}. ChatScreen may speak recap/active-subject/${JSON.stringify(EPHEMERAL_CLARIFY_REPLY)} — UNKNOWN on this seam.`;
      }
    }
    const db_after = snapshotMedications(db);
    const social = snapshotSocial(db);
    const db_diff: DbDiff = diffMedications(db_before, db_after);
    const obs: TurnObs = {
      turn: i + 1,
      input,
      handled: outcome.handled || described.route_kind === 'device_action+dispatch',
      source: outcome.handled ? outcome.source : (described.route_kind === 'device_action+dispatch' ? 'dispatchAction' : null),
      route_kind: described.route_kind,
      route_reason: described.route_reason,
      pending_key_before,
      pending_key_after: session.peekPendingKey(),
      commit_statuses: described.commit_statuses,
      commit_pending_keys: described.commit_pending_keys,
      response: described.response,
      realized_response_seam: described.response,
      realization_note,
      device_action,
      capability_urls: [...openURLs],
      db_delta: countDelta(db_diff),
      exact_zero_delta: zeroDelta(db_diff),
      list_items_after: db_after.list_items.map((x) => ({ list_name: x.list_name, body: x.body })),
      medications_after: db_after.medications.map((m) => ({ name: m.name, notes: m.notes, is_active: m.is_active })),
      medical_records_after: db_after.medical_records.map((r) => ({
        doctor_name: r.doctor_name,
        notes: r.notes,
        visit_outcome: r.visit_outcome,
      })),
      contacts_after: social.contacts,
      facts_after: social.facts,
      flags: [],
      classification: 'UNKNOWN',
      classification_why: '',
      evidence_layer: 'CODE',
    };
    const graded = classifyTurn(scenario, obs);
    obs.classification = graded.cls;
    obs.classification_why = graded.why;
    turns.push(obs);
  }
  return {
    id: scenario.id,
    family: scenario.family,
    title: scenario.title,
    mustPass: scenario.mustPass,
    notes: scenario.notes,
    classification: classifyScenario(scenario, turns),
    turns,
  };
}

const CLASS_TONE: Record<NcaClass, string> = {
  PASS: GREEN,
  UNSUPPORTED: YELLOW,
  WRONG: RED,
  TRUST_FAILURE: RED,
  UNKNOWN: DIM,
};

export async function runNaturalConversationAcceptanceV1() {
  const git = captureGitMeta(process.cwd());
  const results = [];
  let continuityFailed = 0;
  console.log(`\n${BOLD}Herald Natural Conversation Acceptance Corpus V1${RESET}`);
  console.log(`${DIM}measurement only; production behavior unchanged${RESET}`);
  console.log(`${DIM}seam: normalizeInput → processUtterance (ChatScreen recap/Linking not included)${RESET}\n`);

  for (const scenario of NCA_V1_SCENARIOS) {
    const result = await runScenario(scenario);
    results.push(result);
    const tone = CLASS_TONE[result.classification];
    const tag = result.mustPass ? 'mustPass' : 'measure';
    console.log(`${tone}${result.classification}${RESET}  ${scenario.id}  ${DIM}${tag}${RESET}`);
    if (result.mustPass && result.classification !== 'PASS') continuityFailed++;
    for (const t of result.turns) {
      console.log(`${DIM}       T${t.turn} ${t.classification} handled=${t.handled} kind=${t.route_kind} pending=${t.pending_key_after} zero=${t.exact_zero_delta}${RESET}`);
      console.log(`${DIM}         why: ${t.classification_why}${RESET}`);
      if (t.response) console.log(`${DIM}         say: ${JSON.stringify(t.response)}${RESET}`);
    }
  }

  const counts: Record<NcaClass, number> = {
    PASS: 0, UNSUPPORTED: 0, WRONG: 0, TRUST_FAILURE: 0, UNKNOWN: 0,
  };
  for (const r of results) counts[r.classification]++;

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evidence');
  const artifactPath = path.join(dir, 'nca.v1.json');
  const packet = {
    schema_version: NCA_V1_SCHEMA,
    git,
    production_seam: 'normalizeInput → processUtterance → ConversationSession + DOMAIN_WRITERS; classifyLLM stub; llmReady=false; ChatScreen recap/canned/Linking not on seam',
    classifier_stub: { llmReady: false, classifyLLM: 'ok_empty_intents' },
    ephemeral_clarify_reply: EPHEMERAL_CLARIFY_REPLY,
    scenarios: results,
    summary: {
      total: results.length,
      ...counts,
      continuity_mustPass_failed: continuityFailed,
    },
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.log(`${DIM}  evidence not written (${err instanceof Error ? err.message : String(err)})${RESET}`);
  }

  console.log(`\n${BOLD}NCA V1: ${results.length} scenarios  PASS=${counts.PASS} UNSUPPORTED=${counts.UNSUPPORTED} WRONG=${counts.WRONG} TRUST_FAILURE=${counts.TRUST_FAILURE} UNKNOWN=${counts.UNKNOWN}${RESET}`);
  console.log(`  evidence: ${artifactPath}`);

  // Gate: one test per scenario was classified; Continuity mustPass must be PASS.
  const failures: Array<{ label: string; expected: string; got: string }> = [];
  for (const r of results) {
    if (r.mustPass && r.classification !== 'PASS') {
      failures.push({
        label: r.id,
        expected: 'PASS (Continuity V1)',
        got: `${r.classification}: ${r.turns.map((t) => `T${t.turn}=${t.classification}(${t.classification_why})`).join('; ')}`,
      });
    }
  }

  const passed = results.length - failures.length;
  const failed = failures.length;
  if (failed) {
    for (const f of failures) console.log(`${RED}✗ ${f.label}${RESET}\n    expected: ${f.expected}\n    got: ${f.got}`);
  }
  return { passed, failed, total: results.length, artifactPath, packet, failures };
}
