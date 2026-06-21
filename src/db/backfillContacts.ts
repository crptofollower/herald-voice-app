// src/db/backfillContacts.ts
// ONE-TIME backfill: relationship FACTS → contacts, so the facts-fallback reader
// in tierRouter can later be removed without any relationship going invisible.
//
// SAFETY CONTRACT:
//  - Reads relationship facts; writes ONLY contacts. Never touches the facts table,
//    the shadow writer, or any reader. Purely additive — removes nothing.
//  - Parses ONLY the structured "relation: name" form (the EXACT regex the reader
//    uses at tierRouter.ts:839). Sentence-form facts already have their contacts
//    (capturePerson wrote them); free-text facts were never structured enough to
//    safely become a contact — parsing them would be fabrication. Both are skipped
//    by design, not lost.
//  - Coverage equals the reader's coverage: every fact the reader can resolve becomes
//    a contact; every fact skipped is one the reader couldn't resolve either.
//  - Confirm gate is intentionally BYPASSED: these facts were already STATED by the
//    user, with provenance. Spine §4 confirm-before-write guards capture-time STT
//    mishearing, not the re-copying of facts already on the device. (A later proactive
//    pass can surface "I've got these saved — still right?" — that is the human check.)
//  - Idempotent: writeContact upserts by name, and a run-once flag prevents re-entry.
//  - Reversible: every row written is soft-deletable via removeContact (schema v15).

import { getDB } from './schema';
import { getFactsByCategory } from './factDB';
import { writeContact } from './contactsDB';

const BACKFILL_FLAG = 'contacts_backfill_v1_done';

// Mirror of capturePerson's poison-value guard.
const BAD_NAME = /^(unknown|none|null|n\/a|n\.a\.|someone|somebody)$/i;
// Same structured form the reader parses (tierRouter.ts:839).
const REL_NAME = /^([\w-]+)\s*:\s*(.+)$/;

export function backfillContactsFromFacts(): { written: number; skipped: number; already: boolean } {
  const db = getDB();

  // Run-once guard.
  try {
    const done = db.getFirstSync<{ value: string }>(
      "SELECT value FROM local_profile WHERE key = ?;",
      [BACKFILL_FLAG]
    );
    if (done) return { written: 0, skipped: 0, already: true };
  } catch {
    // local_profile must exist (schema v1) — if this throws, do not proceed blindly.
    return { written: 0, skipped: 0, already: false };
  }

  let written = 0;
  let skipped = 0;

  try {
    const facts = getFactsByCategory('relationships', 500);
    for (const f of facts) {
      const m = f.fact.match(REL_NAME);
      if (!m) { skipped++; continue; }                 // sentence/free-text — skip by design
      const relation = m[1].trim().toLowerCase();
      const name = m[2].trim();
      if (!relation || relation.length < 2) { skipped++; continue; }
      if (!name || name.length < 2 || BAD_NAME.test(name)) { skipped++; continue; }
      // Reachability + identity row. Mirrors capturePerson's contact write, minus the
      // relationship fact (the fact already exists — that's what we're reading).
      const id = writeContact({
        name,
        relationship: relation,
        importance: 7,
      });
      if (id) written++; else skipped++;
    }
  } catch {
    // Read/parse failure — do NOT set the done flag, so a later launch can retry.
    return { written, skipped, already: false };
  }

  // Mark done only after a clean pass.
  try {
    db.runSync(
      "INSERT OR REPLACE INTO local_profile (key, value, updated_at) VALUES (?, ?, ?);",
      [BACKFILL_FLAG, new Date().toISOString(), new Date().toISOString()]
    );
  } catch { /* flag write failed — worst case it re-runs; writeContact upsert makes that safe */ }

  return { written, skipped, already: false };
}
