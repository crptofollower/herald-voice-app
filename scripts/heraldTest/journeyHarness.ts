// Thin Journey Harness V1 — Scenario 17 only.
// Production seam: normalizeInput → processUtterance → ConversationSession → setDB.
// No ChatScreen. No second router. No Qwen.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { processUtterance, type UtteranceOutcome } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import type { RouteDecision } from '../../src/routing/routeIntent.ts';

export const JOURNEY_SCHEMA_VERSION = 'herald.journey.v1';

export type ContractVerdict = 'PASS' | 'FAIL' | 'NOT_GRADEABLE';

export type MedicationRow = {
  id: string;
  name: string;
  dosage: string | null;
  frequency: string | null;
  is_active: number;
  notes: string | null;
};

export type MedicalRecordRow = {
  id: string;
  doctor_name: string | null;
  notes: string | null;
  visit_date: string | null;
  visit_outcome: string | null;
  status: string | null;
};

export type ListRow = {
  id: string;
  name: string;
};

export type ListItemRow = {
  id: string;
  list_id: string;
  list_name: string;
  body: string;
  checked: number;
  removed_at: string | null;
  created_at: string;
};

export type DbSnapshot = {
  medications: MedicationRow[];
  medical_records: MedicalRecordRow[];
  lists: ListRow[];
  list_items: ListItemRow[];
};

export type DbDiff = {
  added: MedicationRow[];
  removed: MedicationRow[];
  changed: Array<{ before: MedicationRow; after: MedicationRow }>;
  medical_records_added: MedicalRecordRow[];
  medical_records_removed: MedicalRecordRow[];
  medical_records_changed: Array<{ before: MedicalRecordRow; after: MedicalRecordRow }>;
  lists_added: ListRow[];
  lists_removed: ListRow[];
  lists_changed: Array<{ before: ListRow; after: ListRow }>;
  list_items_added: ListItemRow[];
  list_items_removed: ListItemRow[];
  list_items_changed: Array<{ before: ListItemRow; after: ListItemRow }>;
};

export type ContractResult = {
  id: string;
  description: string;
  verdict: ContractVerdict;
  evidence: string;
};

export type TurnRecord = {
  turn: number;
  input: string;
  input_normalized: string;
  route_owner: string | null;
  route_kind: string | null;
  route_reason: string | null;
  route_source: string | null;
  pending_key_before: string | null;
  pending_key_after: string | null;
  pending_after: boolean;
  response: string | null;
  commit_statuses: string[];
  commit_pending_keys: Array<string | null>;
  opr_presented_ids: string[] | null;
  db_before: DbSnapshot;
  db_after: DbSnapshot;
  db_diff: DbDiff;
  contracts: ContractResult[];
  result: ContractVerdict;
};

export type JourneyPacket = {
  schema_version: string;
  journey_id: string;
  run_id: string;
  git: { branch: string; head: string; dirty: boolean; status_short: string };
  seed: string;
  production_seam: string;
  contracts: string[];
  turns: TurnRecord[];
  overall: ContractVerdict;
  first_material_divergence: string | null;
  failure_class: 'none' | 'PRODUCT_FAIL' | 'HARNESS_FAIL';
  journey_contracts?: ContractResult[];
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT,
    is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT,
    status TEXT DEFAULT 'noted', surfaced_at TEXT, visit_outcome TEXT,
    outcome_asked_at TEXT, removed_at TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_contacts (
    id TEXT PRIMARY KEY, name TEXT, specialty TEXT, phone TEXT, address TEXT,
    is_primary INTEGER DEFAULT 0, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, all_day INTEGER DEFAULT 0, notes TEXT, cached_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, fact TEXT NOT NULL, category TEXT,
    confidence TEXT, source_date TEXT, use_count INTEGER DEFAULT 0,
    last_used TEXT, context_type TEXT, valid_until TEXT, importance_score INTEGER
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
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
    created_at TEXT NOT NULL,
    FOREIGN KEY (list_id) REFERENCES lists(id)
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => {
      try { return db.prepare(s).all(...p); } catch { return []; }
    },
    getFirstSync: (s: string, p: unknown[] = []) => {
      try { return db.prepare(s).get(...p) ?? null; } catch { return null; }
    },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

export function snapshotMedications(db: Database.Database): DbSnapshot {
  const medications = db.prepare(
    `SELECT id, name, dosage, frequency, is_active, notes
     FROM medications ORDER BY created_at, id`,
  ).all() as MedicationRow[];
  const medical_records = db.prepare(
    `SELECT id, doctor_name, notes, visit_date, visit_outcome, status
     FROM medical_records ORDER BY created_at, id`,
  ).all() as MedicalRecordRow[];
  const lists = db.prepare(
    `SELECT id, name FROM lists ORDER BY created_at, id`,
  ).all() as ListRow[];
  const list_items = db.prepare(
    `SELECT li.id, li.list_id, l.name AS list_name, li.body, li.checked, li.removed_at, li.created_at
     FROM list_items li
     JOIN lists l ON l.id = li.list_id
     ORDER BY li.created_at, li.id`,
  ).all() as ListItemRow[];
  return { medications, medical_records, lists, list_items };
}

function diffRows<T extends { id: string }>(
  before: T[],
  after: T[],
): { added: T[]; removed: T[]; changed: Array<{ before: T; after: T }> } {
  const beforeById = new Map(before.map((r) => [r.id, r]));
  const afterById = new Map(after.map((r) => [r.id, r]));
  const added: T[] = [];
  const removed: T[] = [];
  const changed: Array<{ before: T; after: T }> = [];
  for (const [id, row] of afterById) {
    const prev = beforeById.get(id);
    if (!prev) added.push(row);
    else if (JSON.stringify(prev) !== JSON.stringify(row)) changed.push({ before: prev, after: row });
  }
  for (const [id, row] of beforeById) {
    if (!afterById.has(id)) removed.push(row);
  }
  return { added, removed, changed };
}

export function diffMedications(before: DbSnapshot, after: DbSnapshot): DbDiff {
  const meds = diffRows(before.medications, after.medications);
  const recs = diffRows(before.medical_records, after.medical_records);
  const lists = diffRows(before.lists, after.lists);
  const items = diffRows(before.list_items, after.list_items);
  return {
    added: meds.added,
    removed: meds.removed,
    changed: meds.changed,
    medical_records_added: recs.added,
    medical_records_removed: recs.removed,
    medical_records_changed: recs.changed,
    lists_added: lists.added,
    lists_removed: lists.removed,
    lists_changed: lists.changed,
    list_items_added: items.added,
    list_items_removed: items.removed,
    list_items_changed: items.changed,
  };
}

export function describeOutcome(outcome: UtteranceOutcome): {
  route_owner: string | null;
  route_kind: string | null;
  route_reason: string | null;
  route_source: string | null;
  response: string | null;
  commit_statuses: string[];
  commit_pending_keys: Array<string | null>;
} {
  if (outcome.handled) {
    if (outcome.source === 'emergency') {
      return {
        route_owner: 'emergency',
        route_kind: 'emergency',
        route_reason: null,
        route_source: 'emergency',
        response: null,
        commit_statuses: [],
        commit_pending_keys: [],
      };
    }
    const pendingCommit = outcome.commits.find((c) => c.status === 'pending');
    const reason = pendingCommit && pendingCommit.status === 'pending'
      ? pendingCommit.pendingKey
      : outcome.source;
    return {
      route_owner: outcome.source,
      route_kind: outcome.source,
      route_reason: reason,
      route_source: outcome.source,
      response: outcome.responseText,
      commit_statuses: outcome.commits.map((c) => c.status),
      commit_pending_keys: outcome.commits.map((c) => (
        c.status === 'pending' ? c.pendingKey : null
      )),
    };
  }
  const rd: RouteDecision = outcome.routeDecision;
  const response = rd.kind === 'device_read' ? rd.response : null;
  return {
    route_owner: rd.kind,
    route_kind: rd.kind,
    route_reason: 'reason' in rd ? String(rd.reason ?? '') : null,
    route_source: rd.kind === 'device_read' ? 'device_read' : null,
    response,
    commit_statuses: [],
    commit_pending_keys: [],
  };
}

export function captureGitMeta(cwd: string): JourneyPacket['git'] {
  const run = (cmd: string) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();
  try {
    return {
      branch: run('git rev-parse --abbrev-ref HEAD'),
      head: run('git rev-parse HEAD'),
      dirty: run('git status --porcelain') !== '',
      status_short: run('git status --short'),
    };
  } catch {
    return { branch: 'unknown', head: 'unknown', dirty: true, status_short: 'git unavailable' };
  }
}

export function openJourneyDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const orderedPresentation = new OrderedPresentationHolder();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [] as string[], lists: [] as string[] },
  };
  return { db, session, deps, orderedPresentation };
}

export async function runJourneyTurn(
  db: Database.Database,
  session: ConversationSession,
  deps: Parameters<typeof processUtterance>[2],
  turn: number,
  input: string,
  orderedPresentation?: OrderedPresentationHolder | null,
): Promise<TurnRecord> {
  const pending_key_before = session.peekPendingKey();
  const db_before = snapshotMedications(db);
  const input_normalized = normalizeInput(input);
  const outcome = await processUtterance(
    input_normalized,
    session,
    deps,
    null,
    null,
    orderedPresentation ?? null,
  );
  const described = describeOutcome(outcome);
  const db_after = snapshotMedications(db);
  const live = orderedPresentation?.peek();
  return {
    turn,
    input,
    input_normalized,
    ...described,
    pending_key_before,
    pending_key_after: session.peekPendingKey(),
    pending_after: session.hasPending(),
    opr_presented_ids: live?.owner === 'grocery' ? [...live.presentedIds] : null,
    db_before,
    db_after,
    db_diff: diffMedications(db_before, db_after),
    contracts: [],
    result: 'NOT_GRADEABLE',
  };
}

export function requiredTurnEvidencePresent(t: TurnRecord): boolean {
  if (!t.input) return false;
  if (t.response == null || t.response === '') return false;
  if (!t.db_before || !t.db_after || !t.db_diff) return false;
  if (!Array.isArray(t.db_before.list_items) || !Array.isArray(t.db_after.list_items)) return false;
  if (!Array.isArray(t.db_before.lists) || !Array.isArray(t.db_after.lists)) return false;
  if (typeof t.pending_after !== 'boolean') return false;
  return true;
}

export function writeJourneyPacket(packet: JourneyPacket, filename: string): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, filename);
  fs.writeFileSync(out, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  return out;
}
