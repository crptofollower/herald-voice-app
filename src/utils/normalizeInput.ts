// src/utils/normalizeInput.ts
// HERALD INPUT FRONT DOOR.
//
// Every user message — typed or spoken, from any device (Samsung, Pixel, Motorola,
// OnePlus, iOS, …) — passes through here BEFORE any logic touches it. Routing,
// capture, SQL, and (later) the on-device LLM all consume normalized text.
//
// WHY: different keyboards and speech-to-text engines emit different characters for
// the SAME sentence — curly vs straight quotes, em/en dashes, unicode spaces,
// zero-width junk, non-NFC accents. Normalizing ONCE, at one choke point, means
// nothing downstream ever has to care which device produced the text. This is the
// device-agnostic layer: it serves the deterministic regex/SQL today and the LLM
// later, identically, online and offline.
//
// SCOPE: punctuation + encoding + whitespace hygiene ONLY.
//   - Does NOT lowercase (casing is handled at match time and preserved for display).
//   - Does NOT alter meaning — digits, names, drug names, dosages are untouched.
//     Safe alongside the medical guardrail (this never rewrites a number or a word,
//     only the encoding of quotes/dashes/spaces).
//   - Idempotent: normalizing already-clean text returns it unchanged, so it is safe
//     to call at more than one layer (front door + router) as defense in depth.

export function normalizeInput(raw: string): string {
  if (!raw) return '';

  let s = raw;

  // 1. Unicode canonical form so accented characters compare consistently across
  //    keyboards/STT engines (e.g. iOS vs Samsung composing "é" differently).
  try { s = s.normalize('NFC'); } catch { /* very old runtime — skip */ }

  // 2. Smart / curly quotes → straight ASCII. (The Samsung-keyboard apostrophe bug:
  //    "wife’s" never matched "wife's" until this ran.)
  s = s
    .replace(/[\u2018\u2019\u02BC\u201B]/g, "'")   // ‘ ’ ʼ ‛  → '
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"');  // “ ” „ ‟  → "

  // 3. Dashes and ellipsis → ASCII.
  s = s
    .replace(/[\u2010-\u2015\u2212]/g, '-')        // ‐ ‑ ‒ – — ― −  → -
    .replace(/\u2026/g, '...');                    // …  → ...

  // 4. Whitespace: drop zero-width chars, fold every unicode space to a normal space,
  //    collapse runs, trim ends.
  s = s
    .replace(/[\u200B-\u200D\uFEFF]/g, '')                          // zero-width / BOM
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ') // unicode spaces
    .replace(/\s+/g, ' ')
    .trim();

  return s;
}
