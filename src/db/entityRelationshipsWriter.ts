// Rung 5 Step 3 — sole entity_relationships mutation authority.
// Never creates entities. Never auto-merges. Never duplicates Me↔contact kinship.

import { getDB } from './schema';
import { ME_ENTITY_ID, withContactPersonEntityTx } from './personEntityIdentity';

export const EDGE_SOURCE_USER_UTTERANCE = 'user_utterance';

export const CANONICAL_RELATIONS: Record<string, { symmetric: boolean; supersedable: boolean }> = {
  parent_of: { symmetric: false, supersedable: false },
  grandparent_of: { symmetric: false, supersedable: false },
  sibling_of: { symmetric: true, supersedable: false },
  spouse_of: { symmetric: true, supersedable: true },
  partner_of: { symmetric: false, supersedable: true },
  ex_spouse_of: { symmetric: false, supersedable: true },
  patient_of: { symmetric: false, supersedable: true },
  client_of: { symmetric: false, supersedable: true },
  prescribed_by: { symmetric: false, supersedable: true },
  owns: { symmetric: false, supersedable: true },
  lives_in: { symmetric: false, supersedable: true },
  attends: { symmetric: false, supersedable: true },
  works_at: { symmetric: false, supersedable: true },
  member_of: { symmetric: false, supersedable: true },
  involves: { symmetric: false, supersedable: false },
  located_at: { symmetric: false, supersedable: false },
  related_to: { symmetric: false, supersedable: true },
};

const ME_KINSHIP_RELATIONS = new Set([
  'parent_of',
  'grandparent_of',
  'sibling_of',
  'spouse_of',
  'partner_of',
  'ex_spouse_of',
  'related_to',
]);

const ACTIVE_PREDICATE = 'ended_at IS NULL AND removed_at IS NULL';

export type EdgeWriteInput = {
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  statedAs: string;
  rawPhrase: string;
  source?: string;
};

export type EdgeWriteResult =
  | { ok: true; action: 'inserted' | 'unchanged'; edgeId: string }
  | {
      ok: false;
      reason:
        | 'unresolved_endpoint'
        | 'missing_provenance'
        | 'invalid_source'
        | 'me_contact_kinship_duplicate'
        | 'non_supersedable'
        | 'not_found';
    };

export type EdgeRow = {
  id: string;
  from_entity: string;
  relation: string;
  to_entity: string;
  created_at: string;
  stated_as: string | null;
  raw_phrase: string | null;
  source: string | null;
  ended_at: string | null;
  removed_at: string | null;
};

type PreparedEdge = {
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  statedAs: string;
  rawPhrase: string;
  source: string;
};

function nowUtcZ(): string {
  return new Date().toISOString();
}

function entityExists(id: string): boolean {
  const db = getDB();
  const row = db.getFirstSync<{ id: string }>(
    'SELECT id FROM entities WHERE id = ? LIMIT 1;',
    [id],
  );
  return !!row;
}

function findActiveEdge(fromEntityId: string, relation: string, toEntityId: string): EdgeRow | null {
  const db = getDB();
  return db.getFirstSync<EdgeRow>(
    `SELECT id, from_entity, relation, to_entity, created_at, stated_as, raw_phrase, source, ended_at, removed_at
     FROM entity_relationships
     WHERE from_entity = ? AND relation = ? AND to_entity = ? AND ${ACTIVE_PREDICATE}
     LIMIT 1;`,
    [fromEntityId, relation, toEntityId],
  ) ?? null;
}

function loadEdge(edgeId: string): EdgeRow | null {
  const db = getDB();
  return db.getFirstSync<EdgeRow>(
    `SELECT id, from_entity, relation, to_entity, created_at, stated_as, raw_phrase, source, ended_at, removed_at
     FROM entity_relationships WHERE id = ? LIMIT 1;`,
    [edgeId],
  ) ?? null;
}

function contactRelationship(entityId: string): string | null {
  const db = getDB();
  try {
    const row = db.getFirstSync<{ relationship: string | null }>(
      `SELECT relationship FROM contacts WHERE id = ? AND removed_at IS NULL LIMIT 1;`,
      [entityId],
    );
    const rel = row?.relationship?.trim();
    return rel || null;
  } catch {
    return null;
  }
}

function duplicatesMeContactKinship(fromId: string, toId: string, relation: string): boolean {
  if (!ME_KINSHIP_RELATIONS.has(relation)) return false;
  const meInvolved = fromId === ME_ENTITY_ID || toId === ME_ENTITY_ID;
  if (!meInvolved) return false;
  const other = fromId === ME_ENTITY_ID ? toId : fromId;
  return contactRelationship(other) != null;
}

function canonicalizeEndpoints(fromId: string, toId: string, relation: string): { from: string; to: string } {
  const meta = CANONICAL_RELATIONS[relation];
  if (meta?.symmetric && fromId !== toId) {
    return fromId < toId ? { from: fromId, to: toId } : { from: toId, to: fromId };
  }
  return { from: fromId, to: toId };
}

function floorRelation(rawRelation: string): string {
  const rel = rawRelation.trim();
  return Object.prototype.hasOwnProperty.call(CANONICAL_RELATIONS, rel) ? rel : 'related_to';
}

function prepareWrite(input: EdgeWriteInput): EdgeWriteResult | { ok: true; prepared: PreparedEdge } {
  const statedAs = (input.statedAs ?? '').trim();
  const rawPhrase = (input.rawPhrase ?? '').trim();
  if (!statedAs || !rawPhrase) {
    return { ok: false, reason: 'missing_provenance' };
  }
  const source = (input.source ?? EDGE_SOURCE_USER_UTTERANCE).trim();
  if (source !== EDGE_SOURCE_USER_UTTERANCE) {
    return { ok: false, reason: 'invalid_source' };
  }
  const fromRaw = (input.fromEntityId ?? '').trim();
  const toRaw = (input.toEntityId ?? '').trim();
  if (!fromRaw || !toRaw || !entityExists(fromRaw) || !entityExists(toRaw)) {
    return { ok: false, reason: 'unresolved_endpoint' };
  }
  const relation = floorRelation(input.relation ?? '');
  const ends = canonicalizeEndpoints(fromRaw, toRaw, relation);
  if (duplicatesMeContactKinship(ends.from, ends.to, relation)) {
    return { ok: false, reason: 'me_contact_kinship_duplicate' };
  }
  return {
    ok: true,
    prepared: {
      fromEntityId: ends.from,
      toEntityId: ends.to,
      relation,
      statedAs,
      rawPhrase,
      source: EDGE_SOURCE_USER_UTTERANCE,
    },
  };
}

function insertPrepared(prepared: PreparedEdge): EdgeWriteResult {
  const existing = findActiveEdge(prepared.fromEntityId, prepared.relation, prepared.toEntityId);
  if (existing) {
    return { ok: true, action: 'unchanged', edgeId: existing.id };
  }
  const db = getDB();
  const id = `er_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const created = nowUtcZ();
  db.runSync(
    `INSERT INTO entity_relationships
       (id, from_entity, relation, to_entity, created_at, stated_as, raw_phrase, source, ended_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL);`,
    [
      id,
      prepared.fromEntityId,
      prepared.relation,
      prepared.toEntityId,
      created,
      prepared.statedAs,
      prepared.rawPhrase,
      prepared.source,
    ],
  );
  return { ok: true, action: 'inserted', edgeId: id };
}

export function writeRelationshipEdge(input: EdgeWriteInput): EdgeWriteResult {
  const prepared = prepareWrite(input);
  if (!prepared.ok) return prepared;
  return withContactPersonEntityTx(() => insertPrepared(prepared.prepared));
}

export function supersedeRelationshipEdge(
  currentEdgeId: string,
  replacement: EdgeWriteInput,
): EdgeWriteResult {
  const current = loadEdge(currentEdgeId);
  if (!current || current.ended_at || current.removed_at) {
    return { ok: false, reason: 'not_found' };
  }
  const meta = CANONICAL_RELATIONS[current.relation];
  if (meta && meta.supersedable === false) {
    return { ok: false, reason: 'non_supersedable' };
  }
  const prepared = prepareWrite(replacement);
  if (!prepared.ok) return prepared;
  return withContactPersonEntityTx(() => {
    const db = getDB();
    db.runSync(
      `UPDATE entity_relationships SET ended_at = ? WHERE id = ? AND ${ACTIVE_PREDICATE};`,
      [nowUtcZ(), currentEdgeId],
    );
    return insertPrepared(prepared.prepared);
  });
}

export function softRemoveRelationshipEdge(edgeId: string): boolean {
  return withContactPersonEntityTx(() => {
    const db = getDB();
    const result = db.runSync(
      `UPDATE entity_relationships SET removed_at = ?
       WHERE id = ? AND removed_at IS NULL;`,
      [nowUtcZ(), edgeId],
    );
    return (result?.changes ?? 0) > 0;
  });
}

export function getActiveEdges(fromEntity?: string, toEntity?: string): EdgeRow[] {
  const db = getDB();
  const clauses = [ACTIVE_PREDICATE];
  const params: string[] = [];
  if (fromEntity) {
    clauses.push('from_entity = ?');
    params.push(fromEntity);
  }
  if (toEntity) {
    clauses.push('to_entity = ?');
    params.push(toEntity);
  }
  return db.getAllSync<EdgeRow>(
    `SELECT id, from_entity, relation, to_entity, created_at, stated_as, raw_phrase, source, ended_at, removed_at
     FROM entity_relationships
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at, id;`,
    params,
  );
}
