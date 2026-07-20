// src/utils/evidenceRegistry.ts
// ROUTING_FIELD_GROUNDING_DESIGN_SPEC.md — Commit 1: the single evidence
// authority (D5). Lands INERT — nothing imports this yet. Commit 2 wires
// verifyVerbatim to read from it.
//
// For every canonical routing-field value, which surface forms in a raw
// utterance count as evidence that a classifier-emitted value is actually
// SUPPORTED by what the user said — not merely legal per closed-vocabulary
// membership (the root-cause distinction the whole spec exists to draw).
//
// D1  — identity is always a registered surface form.
// D5  — this module is the SOLE source of surface forms; nothing else may
//       answer "what counts as evidence for this value."
// D6  — a device-proven false reject is fixed by registering the missing
//       surface form HERE — never by weakening the gate, never in the
//       classifier prompt, never by re-exempting a field.
//
// FAMILY fan-out finding (founder-ratified 2026-07-20): FAMILY_SYNONYMS
// (familyRead.ts) is built for READ-QUERY BROADENING — a spoken word expands
// to every stored value a DB read should match. Several of its keys (spouse,
// partner, child, children, kid, kids) fan out across gender-distinct,
// mutually exclusive relations. Inverting that map mechanically would let an
// ambiguous word like "spouse" register as evidence for the SPECIFIC value
// "wife" — a wrong-value fabrication risk, not a coverage gap. Family
// therefore registers IDENTITY ONLY by default. Every non-identity family
// surface form below is an explicit, hand-reviewed addition.
//
// SERVICE_SYNONYMS / INSURANCE_SYNONYMS do not have this problem — every
// value in one of their clusters is a genuine alias of the same real-world
// thing (hvac/ac/heating/furnace = one category; home/homeowners/house = one
// policy type). Full inversion is safe there and used.
//
// listName is OUT OF SCOPE for this arc (founder decision 2026-07-20) —
// implicit default inference is a different mechanism, its own constitutional
// review. Carry Item C5 / spec §9.
//
// specialty is OUT OF SCOPE (D7 superseded by the Commit-1 execution
// audit — no closed classifier vocabulary exists for it anywhere in the
// codebase; it remains a VALUE field, grounded via the existing substring
// gate, unchanged by this module).

import { FAMILY_SYNONYMS } from './familyRead';
import { SERVICE_SYNONYMS, INSURANCE_SYNONYMS } from './householdRead';

export type RoutingFieldName = 'relation' | 'category' | 'insType';

export const IN_SCOPE_FIELDS: RoutingFieldName[] = ['relation', 'category', 'insType'];

// canonical value (lowercased) → set of registered surface forms (lowercased)
type EvidenceMap = Map<string, Set<string>>;

const registry: Record<RoutingFieldName, EvidenceMap> = {
  relation: new Map(),
  category: new Map(),
  insType: new Map(),
};

function register(field: RoutingFieldName, canonical: string, surfaceForm: string): void {
  const key = canonical.trim().toLowerCase();
  const form = surfaceForm.trim().toLowerCase();
  if (!key || !form) return;
  const map = registry[field];
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(form);
}

// ─── SERVICE_SYNONYMS / INSURANCE_SYNONYMS — safe full inversion ───────────
// Canonical value = anything that appears as a VALUE anywhere in the map
// (this matches buildClassifierVocab's vocab.categories / vocab.insTypes
// exactly — the same set the classifier is legally allowed to emit).
// Surface forms for a canonical value = itself (identity) + every spoken
// key whose array contains it (safe here — see header).
function registerSameBucketCluster(
  field: 'category' | 'insType',
  synonyms: Record<string, string[]>,
): void {
  for (const [spokenKey, canonicalValues] of Object.entries(synonyms)) {
    for (const canonical of canonicalValues) {
      register(field, canonical, canonical);   // identity
      register(field, canonical, spokenKey);   // spoken key evidences this cluster-mate
    }
  }
}

registerSameBucketCluster('category', SERVICE_SYNONYMS);
registerSameBucketCluster('insType', INSURANCE_SYNONYMS);

// ─── FAMILY_SYNONYMS — identity only, no auto-inversion ────────────────────
// Canonical relation set = every KEY + every VALUE across FAMILY_SYNONYMS,
// mirroring buildClassifierVocab's vocab.relations flattening exactly, so
// nothing legally emittable is left unregistered (D5 completeness).
const FAMILY_CANONICAL_VALUES = new Set<string>();
for (const [k, vals] of Object.entries(FAMILY_SYNONYMS)) {
  FAMILY_CANONICAL_VALUES.add(k.toLowerCase());
  for (const v of vals) FAMILY_CANONICAL_VALUES.add(v.toLowerCase());
}
// STEP_FORMS mirror (llmLayers.ts:48-51, SESSION_W W3c: FAMILY_SYNONYMS ∪
// step forms). Duplicated here rather than imported to avoid a circular
// module dependency (llmLayers.ts already imports this file). Keep in sync
// by hand if llmLayers.ts's STEP_FORMS ever changes — it is a locked,
// six-word, low-churn list.
const STEP_FORMS_MIRROR = [
  'stepson', 'stepdaughter', 'stepmother', 'stepfather',
  'stepbrother', 'stepsister',
];
for (const s of STEP_FORMS_MIRROR) FAMILY_CANONICAL_VALUES.add(s.toLowerCase());
for (const v of FAMILY_CANONICAL_VALUES) register('relation', v, v);

// ─── Explicitly reviewed compositional family forms (founder-ratified) ────
// Each line here is evidence for exactly ONE canonical value — never a
// fan-out. This is the ONLY place non-identity family evidence may be added.
// A device-proven false reject on a legitimate phrasing (D6) is fixed by
// adding a line here, reviewed by hand — never by touching the gate itself.
const FAMILY_COMPOSITIONAL_FORMS: Record<string, string[]> = {
  'mother-in-law': [
    "wife's mother", "wife's mom", "husband's mother", "husband's mom",
    "spouse's mother", "spouse's mom",
  ],
  'father-in-law': [
    "wife's father", "wife's dad", "husband's father", "husband's dad",
    "spouse's father", "spouse's dad",
  ],
  'brother-in-law': [
    "wife's brother", "husband's brother", "spouse's brother",
  ],
  'sister-in-law': [
    "wife's sister", "husband's sister", "spouse's sister",
  ],
};
for (const [canonical, forms] of Object.entries(FAMILY_COMPOSITIONAL_FORMS)) {
  for (const form of forms) register('relation', canonical, form);
}

// ─── Public API (read-only outside this module) ────────────────────────────

/** Registered surface forms for a canonical value. Empty set = fails closed. */
export function getSurfaceForms(field: RoutingFieldName, canonicalValue: string): ReadonlySet<string> {
  return registry[field].get(canonicalValue.trim().toLowerCase()) ?? new Set();
}

/** Every canonical value currently registered for a field. */
export function getRegisteredCanonicalValues(field: RoutingFieldName): string[] {
  return Array.from(registry[field].keys());
}

/** The exact canonical-value universe a field is expected to cover (for completeness tests). */
export function getExpectedCanonicalValues(field: RoutingFieldName): Set<string> {
  if (field === 'relation') return FAMILY_CANONICAL_VALUES;
  if (field === 'category') {
    const s = new Set<string>();
    for (const vals of Object.values(SERVICE_SYNONYMS)) for (const v of vals) s.add(v.toLowerCase());
    return s;
  }
  if (field === 'insType') {
    const s = new Set<string>();
    for (const vals of Object.values(INSURANCE_SYNONYMS)) for (const v of vals) s.add(v.toLowerCase());
    return s;
  }
  return new Set(); // field out of registry scope (not an unaudited vocabulary)
}
