// src/utils/familyRead.ts
// Herald family memory READ-BACK — the read twin of familyCapture.ts.
// Deterministic regex + SQL. No LLM. Answers "who is my wife" / family overview
// on-device, zero network, zero backend cost.
//
// Table queried: contacts (name, relationship, location) — sole authority.
// Do NOT read the facts table. All members per relation (no LIMIT 1).
// NULL location is normal — surface the person without a city.
//
// HARD RULES:
//   - Answer ONLY from real stored rows. Never fabricate a name or location.
//   - No match → honest-friend response.
//   - Statement guard mirrors householdRead — declarative "my X is Y" → null
//     so capture paths handle writes (D2 fix).

import { getDB } from '../db/schema';

export type FamilyReadIntent = { relation: string | null; spoken: string };

// Spoken relation word → canonical contacts.relationship values (person-as-entity:
// a person may match a relation; we return ALL who match, never one).
export const FAMILY_SYNONYMS: Record<string, string[]> = {
  wife: ['wife', 'spouse', 'partner'],
  husband: ['husband', 'spouse', 'partner'],
  spouse: ['spouse', 'wife', 'husband', 'partner'],
  partner: ['partner', 'spouse', 'wife', 'husband'],
  son: ['son'],
  daughter: ['daughter'],
  child: ['son', 'daughter', 'child'],
  children: ['son', 'daughter', 'child'],
  kid: ['son', 'daughter', 'child'],
  kids: ['son', 'daughter', 'child'],
  mom: ['mom', 'mother'],
  mother: ['mother', 'mom'],
  dad: ['dad', 'father'],
  father: ['father', 'dad'],
  brother: ['brother'],
  sister: ['sister'],
  grandson: ['grandson'],
  granddaughter: ['granddaughter'],
  'father-in-law': ['father-in-law'],
  'mother-in-law': ['mother-in-law'],
  'brother-in-law': ['brother-in-law'],
  'sister-in-law': ['sister-in-law'],
  'son-in-law': ['son-in-law'],
  'daughter-in-law': ['daughter-in-law'],
};

// Alternation order is intentional: JS | is left-first, so longer compounds MUST
// precede their roots. Otherwise "father" matches at the hyphen boundary inside
// "father-in-law" and "who is my father-in-law" is mis-read as plain "father".
const FAMILY_RELATION_WORD =
  '(father-in-law|mother-in-law|brother-in-law|sister-in-law|son-in-law|daughter-in-law|wife|husband|spouse|partner|grandson|granddaughter|son|daughter|child|children|kids?|kid|mom|mother|dad|father|brother|sister)';

const FAMILY_RELATION_KEYS = Object.keys(FAMILY_SYNONYMS);

/**
 * Distinct canonical family-relation keys already stored on contacts.
 * Identity evidence only — not a preference reader.
 */
export function listEstablishedFamilyRelationKeys(): string[] {
  const db = getDB();
  try {
    const rows = db.getAllSync<{ relationship: string | null }>(
      `SELECT relationship FROM contacts WHERE removed_at IS NULL AND relationship IS NOT NULL;`,
    );
    const found = new Set<string>();
    for (const row of rows) {
      const rel = (row.relationship ?? '').trim().toLowerCase().replace(/\s+/g, '-');
      if (!rel) continue;
      const key = FAMILY_RELATION_KEYS.find((k) => k === rel)
        ?? FAMILY_RELATION_KEYS.find((k) => (FAMILY_SYNONYMS[k] ?? []).includes(rel));
      if (key) found.add(key);
    }
    return [...found];
  } catch {
    return [];
  }
}

// Detect a family READ. Returns null for declarative statements ("my son is X"),
// mirroring householdRead's statement guard (lines 165–167) so writes fall through
// to familyCapture — this is the D2 fix.
export function detectFamilyRead(text: string): FamilyReadIntent | null {
  const t = text.trim();

  // Statement guard: "my X is Y" with no leading question word → capture, not read.
  if (/^\s*my\s+\w+.*\bis\b/i.test(t) && !/^\s*(who|what|where|do|does|tell|is)\b/i.test(t)) {
    return null;
  }

  // Typeless overview: "tell me about my family", "what do you know about my family"
  if (/\b(about|know).*\bmy\s+family\b/i.test(t) || /\bmy\s+family\b/i.test(t)) {
    return { relation: null, spoken: 'family' };
  }

  // Typed relation read: "who is my wife", "what's my son's name", "who are my sons"
  const q = new RegExp(
    `\\b(?:who(?:'s| is| are)|what(?:'s| is)|do you know|tell me)\\b[^.?]*\\bmy\\s+${FAMILY_RELATION_WORD}`,
    'i',
  );
  const m = t.match(q);
  if (m) {
    return { relation: m[1].toLowerCase(), spoken: m[1].toLowerCase() };
  }

  return null;
}

type ContactRow = { name: string; relationship: string | null; location: string | null };

// Single read authority. Contacts-only, all members per relation, NULL-safe.
export function answerFamilyRead(intent: FamilyReadIntent): string {
  const db = getDB();
  try {
    let rows: ContactRow[];
    if (intent.relation === null) {
      // Typeless: everyone with any family relationship.
      rows = db.getAllSync<ContactRow>(
        `SELECT name, relationship, location FROM contacts
         WHERE relationship IN
           ('wife','husband','spouse','partner','son','daughter','child',
            'mom','mother','dad','father','brother','sister','grandson','granddaughter',
            'father-in-law','mother-in-law','brother-in-law','sister-in-law',
            'son-in-law','daughter-in-law')
           AND removed_at IS NULL
         ORDER BY importance DESC, name ASC;`,
      );
    } else {
      const canon = FAMILY_SYNONYMS[intent.relation] ?? [intent.relation];
      const placeholders = canon.map(() => '?').join(',');
      rows = db.getAllSync<ContactRow>(
        `SELECT name, relationship, location FROM contacts
         WHERE LOWER(relationship) IN (${placeholders})
           AND removed_at IS NULL
         ORDER BY importance DESC, name ASC;`,
        canon.map(c => c.toLowerCase()),
      );
    }

    // De-dupe by identity key (name + relationship, case-insensitive) — the
    // reader's identity key MUST mirror writeContact's identity key. Two people
    // can share a name (a daughter named after her mother); name alone is not
    // a person (BUG C). True duplicate rows (same name, same relationship)
    // still collapse.
    const seen = new Set<string>();
    const people = rows.filter(r => {
      const k = `${r.name.trim().toLowerCase()}|${(r.relationship ?? '').trim().toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (people.length === 0) {
      if (intent.relation === null) {
        return `I don't have any family saved yet. Tell me about your family and I'll remember.`;
      }
      return `I don't have your ${intent.spoken} saved yet. You can tell me anytime — just say "my ${intent.spoken} is ..." and I'll remember.`;
    }

    const describe = (r: ContactRow): string => {
      const name = r.name.trim();
      const rel = r.relationship?.trim();
      const loc = r.location?.trim();
      if (rel && loc) return `${name}, your ${rel}, in ${loc}`;
      if (rel) return `${name}, your ${rel}`;
      if (loc) return `${name}, in ${loc}`;
      return name;
    };

    // Typeless family overview.
    if (intent.relation === null) {
      const list = people.map(p => `• ${describe(p)}`).join(' ');
      return `Here's what I have about your family: ${list}`;
    }

    // Typed relation — one member.
    if (people.length === 1) {
      const p = people[0];
      const name = p.name.trim();
      const loc = p.location?.trim();
      if (loc) {
        return `Your ${intent.spoken} is ${name} — in ${loc}.`;
      }
      return `Your ${intent.spoken} is ${name}.`;
    }

    // Typed relation — multiple members (e.g. two sons).
    const parts = people.map(p => {
      const name = p.name.trim();
      const loc = p.location?.trim();
      return loc ? `${name} (in ${loc})` : name;
    });
    return `Your ${intent.spoken} are ${joinNaturally(parts)}.`;
  } catch {
    return `I couldn't pull that up right now. Try again in a moment.`;
  }
}

export type FamilyReadMatch = {
  entityId: string;
  displayName: string;
  relationship: string | null;
};

type FamilyResolveRow = {
  id: string;
  name: string;
  relationship: string | null;
};

/**
 * Flow C establishment resolver. Exactly one live named contact with a
 * stable id, or none. Duplicate same-turn SQL vs answerFamilyRead is
 * acceptable — RouteDecision is not widened to carry structured rows.
 */
function loadFamilyReadRows(intent: FamilyReadIntent): FamilyResolveRow[] {
  const db = getDB();
  let rows: FamilyResolveRow[];
  if (intent.relation === null) {
    rows = db.getAllSync<FamilyResolveRow>(
      `SELECT id, name, relationship FROM contacts
       WHERE relationship IN
         ('wife','husband','spouse','partner','son','daughter','child',
          'mom','mother','dad','father','brother','sister','grandson','granddaughter',
          'father-in-law','mother-in-law','brother-in-law','sister-in-law',
          'son-in-law','daughter-in-law')
         AND removed_at IS NULL
       ORDER BY importance DESC, name ASC;`,
    );
  } else {
    const canon = FAMILY_SYNONYMS[intent.relation] ?? [intent.relation];
    const placeholders = canon.map(() => '?').join(',');
    rows = db.getAllSync<FamilyResolveRow>(
      `SELECT id, name, relationship FROM contacts
       WHERE LOWER(relationship) IN (${placeholders})
         AND removed_at IS NULL
       ORDER BY importance DESC, name ASC;`,
      canon.map(c => c.toLowerCase()),
    );
  }
  const seen = new Set<string>();
  return rows.filter(r => {
    const k = `${r.name.trim().toLowerCase()}|${(r.relationship ?? '').trim().toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function listFamilyReadMatches(intent: FamilyReadIntent): FamilyReadMatch[] {
  try {
    return loadFamilyReadRows(intent).flatMap((row) => {
      const entityId = row.id?.trim();
      const displayName = row.name?.trim();
      if (!entityId || !displayName || displayName.length < 2) return [];
      return [{
        entityId,
        displayName,
        relationship: row.relationship?.trim() || null,
      }];
    });
  } catch {
    return [];
  }
}

export function resolveFamilyRead(intent: FamilyReadIntent): FamilyReadMatch | null {
  try {
    const people = loadFamilyReadRows(intent);
    if (people.length !== 1) return null;
    const p = people[0];
    const entityId = p.id?.trim();
    const displayName = p.name?.trim();
    if (!entityId || !displayName || displayName.length < 2) return null;
    return {
      entityId,
      displayName,
      relationship: p.relationship?.trim() || null,
    };
  } catch {
    return null;
  }
}

// ─── joinNaturally ────────────────────────────────────────────────────────────
// ["A", "B", "C"] → "A, B, and C"  |  ["A", "B"] → "A and B"  |  ["A"] → "A"
function joinNaturally(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
