// Narrow person↔person association capture.
// Shape: "<Name> is <Name>'s <relation>". Both names must already resolve
// uniquely. Me-relative possessives are excluded. No entity creation.

import type { IntentRecord } from '../hooks/llmLayers';
import type { CommitResult } from '../routing/routeIntent';
import { CONFIRM_NO_RE, CONFIRM_YES_RE } from '../routing/conversationSession';
import { resolvePersonIdentity } from '../db/contactsDB';
import { CANONICAL_RELATIONS, writeRelationshipEdge } from '../db/entityRelationshipsWriter';

const POSSESSIVE_ASSOCIATION =
  /^([A-Za-z][A-Za-z'-]*)\s+is\s+([A-Za-z][A-Za-z'-]*)'s\s+(.+?)\s*[.!?]*$/i;

const ME_RELATIVE_POSSESSOR = new Set(['my', 'our', 'his', 'her', 'their']);

const CHILD_STATED = new Set(['son', 'daughter', 'child']);
const PARENT_STATED = new Set(['father', 'dad', 'mother', 'mom', 'parent']);
const GRANDCHILD_STATED = new Set(['grandson', 'granddaughter']);
const GRANDPARENT_STATED = new Set(['grandfather', 'grandmother', 'grandpa', 'grandma', 'grandparent']);
const SIBLING_STATED = new Set(['brother', 'sister', 'sibling']);
const SPOUSE_STATED = new Set(['wife', 'husband', 'spouse']);

export type AssociationDirection =
  | 'possessor_to_subject'
  | 'subject_to_possessor'
  | 'symmetric';

export function mapStatedAssociation(statedAs: string): {
  relation: string;
  direction: AssociationDirection;
} {
  const word = statedAs.trim().toLowerCase().replace(/[.!?]+$/g, '');
  if (CHILD_STATED.has(word)) return { relation: 'parent_of', direction: 'possessor_to_subject' };
  if (PARENT_STATED.has(word)) return { relation: 'parent_of', direction: 'subject_to_possessor' };
  if (GRANDCHILD_STATED.has(word)) return { relation: 'grandparent_of', direction: 'possessor_to_subject' };
  if (GRANDPARENT_STATED.has(word)) return { relation: 'grandparent_of', direction: 'subject_to_possessor' };
  if (SIBLING_STATED.has(word)) return { relation: 'sibling_of', direction: 'symmetric' };
  if (SPOUSE_STATED.has(word)) return { relation: 'spouse_of', direction: 'symmetric' };
  if (word === 'partner') return { relation: 'partner_of', direction: 'subject_to_possessor' };
  return { relation: 'related_to', direction: 'subject_to_possessor' };
}

/**
 * Contact relationship labels that already share one supersedable canonical
 * relation. The related_to fallback is not a declared class. Plural kinship
 * (parent_of, sibling_of) is not supersedable and returns null.
 */
export function exclusiveStatedRelationshipPeers(stated: string): string[] | null {
  const mapped = mapStatedAssociation(stated);
  if (mapped.relation === 'related_to') return null;
  const meta = CANONICAL_RELATIONS[mapped.relation];
  if (!meta?.supersedable) return null;
  if (mapped.relation === 'spouse_of') return [...SPOUSE_STATED];
  if (mapped.relation === 'partner_of') return ['partner'];
  return null;
}

function foldApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC\u0060]/g, "'").trim();
}

function uniquePerson(name: string) {
  const resolved = resolvePersonIdentity(name);
  return resolved.status === 'single' ? resolved.contact : null;
}

export function detectPersonAssociationCapture(text: string): IntentRecord[] {
  const raw = foldApostrophes(text);
  if (!raw) return [];
  const m = raw.match(POSSESSIVE_ASSOCIATION);
  if (!m) return [];
  const subjectName = m[1].trim();
  const possessorName = m[2].trim();
  const statedAs = m[3].trim().replace(/[.!?]+$/g, '').trim();
  if (!statedAs) return [];
  if (ME_RELATIVE_POSSESSOR.has(possessorName.toLowerCase())) return [];
  if (subjectName.toLowerCase() === possessorName.toLowerCase()) return [];
  const subject = uniquePerson(subjectName);
  const possessor = uniquePerson(possessorName);
  if (!subject || !possessor) return [];
  if (subject.id === possessor.id) return [];
  return [{
    type: 'person_association_capture',
    subjectName: subject.name,
    possessorName: possessor.name,
    statedAs,
    raw,
  }];
}

function endpointsFor(
  subjectId: string,
  possessorId: string,
  direction: AssociationDirection,
): { fromEntityId: string; toEntityId: string } {
  if (direction === 'possessor_to_subject') return { fromEntityId: possessorId, toEntityId: subjectId };
  if (direction === 'subject_to_possessor') return { fromEntityId: subjectId, toEntityId: possessorId };
  return { fromEntityId: possessorId, toEntityId: subjectId };
}

export async function addPersonAssociationCapture(
  intent: IntentRecord,
  rawPhrase: string,
): Promise<CommitResult> {
  if (intent.type !== 'person_association_capture') {
    return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
  }
  const statedAs = intent.statedAs.trim();
  const raw = (intent.raw || rawPhrase).trim();
  const subject = uniquePerson(intent.subjectName);
  const possessor = uniquePerson(intent.possessorName);
  if (!subject || !possessor || !statedAs || !raw) {
    return { status: 'failed', ack: "I don't have both of those people yet — I won't store that." };
  }
  const prompt = `${subject.name} is ${possessor.name}'s ${statedAs} — that right?`;
  return {
    status: 'pending',
    prompt,
    pendingKey: 'person_association_capture',
    kind: 'standard',
    resume: async (userText: string): Promise<CommitResult> => {
      const t = userText.trim();
      if (CONFIRM_NO_RE.test(t)) {
        return { status: 'noop', ack: "No problem — I won't remember that." };
      }
      if (!CONFIRM_YES_RE.test(t)) {
        return { status: 'noop', ack: '' };
      }
      const stillSubject = uniquePerson(intent.subjectName);
      const stillPossessor = uniquePerson(intent.possessorName);
      if (!stillSubject || !stillPossessor) {
        return { status: 'failed', ack: "I don't have both of those people yet — I won't store that." };
      }
      const live = mapStatedAssociation(statedAs);
      const liveEnds = endpointsFor(stillSubject.id, stillPossessor.id, live.direction);
      const written = writeRelationshipEdge({
        fromEntityId: liveEnds.fromEntityId,
        toEntityId: liveEnds.toEntityId,
        relation: live.relation,
        statedAs,
        rawPhrase: raw,
      });
      if (!written.ok) {
        return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
      }
      return {
        status: 'committed',
        ack: `I'll remember ${stillSubject.name} is ${stillPossessor.name}'s ${statedAs}.`,
      };
    },
  };
}
