import { writeContactValidated, ContactWriteResult } from './contactsDB';
import { exclusiveStatedRelationshipPeers } from '../utils/personAssociationCapture';

export function capturePerson(p: {
  name: string;
  relationship?: string;
  phone?: string;
  address?: string;
  location?: string;
  importance?: number;
}): ContactWriteResult {
  const name = (p.name ?? '').trim();
  const relationship = p.relationship?.trim() || undefined;

  return writeContactValidated({
    name,
    relationship,
    phone: p.phone,
    address: p.address,
    importance: p.importance ?? (relationship ? 7 : 5),
  }, {
    exclusiveLabels: relationship ? exclusiveStatedRelationshipPeers(relationship) : null,
  });
}
