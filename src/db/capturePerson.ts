// src/db/capturePerson.ts
// THE single writer for a person.
// Identity (WHO) → facts table, authoritative.  Reachability (HOW to reach) → contacts, a projection.
// One call writes both, so the name-read and the call/text-resolve never disagree. (Spine §4a)

import { writeContact } from './contactsDB';
import { writeFact } from './factDB';

const BAD_NAME = /^(unknown|none|null|n\/a|n\.a\.|someone|somebody)$/i;

export function capturePerson(p: {
  name: string;
  relationship?: string;
  phone?: string;
  address?: string;
  importance?: number;
}): void {
  const name = p.name?.trim();
  if (!name || name.length < 2 || BAD_NAME.test(name)) return;

  const relationship = p.relationship?.trim() || undefined;

  // Reachability projection — contacts (upserts by name).
  writeContact({
    name,
    relationship,
    phone: p.phone,
    address: p.address,
    importance: p.importance ?? (relationship ? 7 : 5),
  });

  // Identity — facts is authoritative for WHO. Only when a real relationship
  // is known; a bare name+number is reachability only, not identity.
  if (relationship && !BAD_NAME.test(relationship)) {
    writeFact(`${name} is my ${relationship}`, 'relationships', {
      confidence: 'stated',
      contextType: 'active',
    });
  }
}
