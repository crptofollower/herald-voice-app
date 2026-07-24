import { writeContactValidated, ContactWriteResult } from './contactsDB';
import { writeFact } from './factDB';

const BAD_NAME = /^(unknown|none|null|n\/a|n\.a\.|someone|somebody)$/i;

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
  const location = p.location?.trim() || undefined;

  const result = writeContactValidated({
    name,
    relationship,
    phone: p.phone,
    address: p.address,
    importance: p.importance ?? (relationship ? 7 : 5),
  });

  if (!result.ok) return result;

  if (relationship && !BAD_NAME.test(relationship)) {
    writeFact(
      `${name} is my ${relationship}${location ? `, lives in ${location}` : ''}`,
      'relationships',
      { confidence: 'stated', contextType: 'active' },
    );
  }

  return result;
}
