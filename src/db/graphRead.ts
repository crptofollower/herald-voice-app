// Deterministic person↔person graph read. Single hop over Step-3 active edges.
// Never writes. Never creates nodes. Never reads contacts.relationship as graph truth.

import { getDB } from './schema';
import { resolvePersonIdentity } from './contactsDB';
import {
  CANONICAL_RELATIONS,
  EDGE_SOURCE_USER_UTTERANCE,
  getActiveEdges,
  type EdgeRow,
} from './entityRelationshipsWriter';
import {
  mapStatedAssociation,
  type AssociationDirection,
} from '../utils/personAssociationCapture';

const WHO_ASSOCIATION =
  /^(?:who\s+is|who's|whos)\s+([A-Za-z][A-Za-z'-]*)'s\s+(.+?)\s*[.!?]*$/i;

const ME_RELATIVE_POSSESSOR = new Set(['my', 'our', 'his', 'her', 'their']);

export type PersonAssociationReadIntent = {
  possessorEntityId: string;
  possessorName: string;
  queryWord: string;
  relation: string;
  direction: AssociationDirection;
  rawPhrase: string;
};

function foldApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC\u0060]/g, "'").trim();
}

function foldWord(word: string): string {
  return word.trim().toLowerCase().replace(/[.!?]+$/g, '');
}

function personDisplayName(entityId: string): string | null {
  const db = getDB();
  const contact = db.getFirstSync<{ name: string }>(
    `SELECT name FROM contacts WHERE id = ? AND removed_at IS NULL LIMIT 1;`,
    [entityId],
  );
  const fromContact = contact?.name?.trim();
  if (fromContact) return fromContact;
  const entity = db.getFirstSync<{ name: string }>(
    `SELECT name FROM entities WHERE id = ? LIMIT 1;`,
    [entityId],
  );
  const fromEntity = entity?.name?.trim();
  return fromEntity || null;
}

function otherEndpoint(edge: EdgeRow, possessorId: string): string {
  return edge.from_entity === possessorId ? edge.to_entity : edge.from_entity;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function collectCandidates(intent: PersonAssociationReadIntent): EdgeRow[] {
  if (intent.relation === 'related_to') return [];
  const P = intent.possessorEntityId;
  const R = intent.relation;
  const symmetric = CANONICAL_RELATIONS[R]?.symmetric === true;
  const seen = new Set<string>();
  const rows: EdgeRow[] = [];
  const take = (edge: EdgeRow) => {
    if (edge.relation !== R) return;
    if (edge.source !== EDGE_SOURCE_USER_UTTERANCE) return;
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    rows.push(edge);
  };

  if (symmetric) {
    for (const edge of getActiveEdges(P)) take(edge);
    for (const edge of getActiveEdges(undefined, P)) take(edge);
  } else if (intent.direction === 'possessor_to_subject') {
    for (const edge of getActiveEdges(P)) take(edge);
  } else {
    for (const edge of getActiveEdges(undefined, P)) take(edge);
  }

  if (intent.direction === 'possessor_to_subject' || intent.direction === 'symmetric') {
    const wanted = foldWord(intent.queryWord);
    return rows.filter((edge) => foldWord(edge.stated_as ?? '') === wanted);
  }
  return rows;
}

export function detectPersonAssociationRead(text: string): PersonAssociationReadIntent | null {
  const raw = foldApostrophes(text);
  if (!raw) return null;
  const m = raw.match(WHO_ASSOCIATION);
  if (!m) return null;
  const possessorToken = m[1].trim();
  const queryWord = foldWord(m[2] ?? '');
  if (!queryWord) return null;
  if (ME_RELATIVE_POSSESSOR.has(possessorToken.toLowerCase())) return null;
  const resolved = resolvePersonIdentity(possessorToken);
  if (resolved.status !== 'single') return null;
  const mapped = mapStatedAssociation(queryWord);
  return {
    possessorEntityId: resolved.contact.id,
    possessorName: resolved.contact.name,
    queryWord,
    relation: mapped.relation,
    direction: mapped.direction,
    rawPhrase: raw,
  };
}

export function answerPersonAssociationRead(intent: PersonAssociationReadIntent): string {
  const possessor = intent.possessorName.trim();
  const word = intent.queryWord;
  const edges = collectCandidates(intent);
  const names = edges
    .map((edge) => personDisplayName(otherEndpoint(edge, intent.possessorEntityId)))
    .filter((name): name is string => !!name);

  if (names.length === 0) {
    return `I don't have anyone recorded as ${possessor}'s ${word}.`;
  }

  const spokenAs = foldWord(edges[0]?.stated_as ?? word);
  if (names.length === 1) {
    return `${names[0]} — you told me ${names[0]} is ${possessor}'s ${spokenAs}.`;
  }
  return `You told me ${possessor}'s ${spokenAs} is ${joinNames(names)}.`;
}
