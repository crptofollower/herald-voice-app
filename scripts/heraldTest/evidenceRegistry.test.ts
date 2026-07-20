// scripts/heraldTest/evidenceRegistry.test.ts
// ROUTING_FIELD_GROUNDING_DESIGN_SPEC.md — Commit 1 contract tests.
// Tests the registry module directly. It is INERT (not wired into
// verifyVerbatim yet) — these tests prove the data, not the gate.

import {
  IN_SCOPE_FIELDS,
  getSurfaceForms,
  getRegisteredCanonicalValues,
  getExpectedCanonicalValues,
  type RoutingFieldName,
} from '../../src/utils/evidenceRegistry.ts';

export async function runEvidenceRegistryTests() {
  let passed = 0;
  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    if (cond) passed++;
    else failures.push(label);
  };

  const COVERED_FIELDS: RoutingFieldName[] = ['relation', 'category', 'insType'];

  // ── Registry completeness (D5) — every expected canonical value has ≥1 surface form ──
  for (const field of COVERED_FIELDS) {
    const expected = getExpectedCanonicalValues(field);
    let allCovered = true;
    for (const value of expected) {
      if (getSurfaceForms(field, value).size < 1) allCovered = false;
    }
    check(`completeness: every expected ${field} value has ≥1 surface form`, allCovered);
  }

  // ── Identity inclusion (D1) — every canonical value includes itself ──
  for (const field of COVERED_FIELDS) {
    const expected = getExpectedCanonicalValues(field);
    let allIdentity = true;
    for (const value of expected) {
      if (!getSurfaceForms(field, value).has(value)) allIdentity = false;
    }
    check(`identity: every expected ${field} value registers itself`, allIdentity);
  }

  // ── No duplicate canonical keys ──
  for (const field of IN_SCOPE_FIELDS) {
    const keys = getRegisteredCanonicalValues(field);
    check(`no-duplicates: ${field} registry has no duplicate keys`,
      keys.length === new Set(keys).size);
  }

  // ── Fan-out regression (founder-ratified 2026-07-20) ──
  // Ambiguous family keys must NEVER appear as evidence for a specific
  // gender-distinct value they fan out to.
  const FANOUT_RISK_WORDS = ['spouse', 'partner', 'child', 'children', 'kid', 'kids'];
  const GENDER_DISTINCT_TARGETS = ['wife', 'husband', 'son', 'daughter'];
  let noFanout = true;
  for (const target of GENDER_DISTINCT_TARGETS) {
    const forms = getSurfaceForms('relation', target);
    for (const risky of FANOUT_RISK_WORDS) {
      if (forms.has(risky)) noFanout = false;
    }
  }
  check('fan-out regression: wife/husband/son/daughter register no ambiguous surface forms',
    noFanout);

  // Reverse direction: the ambiguous words themselves must not have been
  // given a gender-distinct value as their own identity accidentally.
  let ambiguousWordsIdentityOnly = true;
  for (const risky of FANOUT_RISK_WORDS) {
    const forms = getSurfaceForms('relation', risky);
    for (const target of GENDER_DISTINCT_TARGETS) {
      if (forms.has(target)) ambiguousWordsIdentityOnly = false;
    }
  }
  check('fan-out regression: spouse/partner/child/kid register no gender-distinct forms',
    ambiguousWordsIdentityOnly);

  // ── Compositional forms are per-value, never cross-contaminated (pre-check for T14) ──
  const compositionalCases = [
    ['mother-in-law', "wife's mother", 'father-in-law'],
    ['father-in-law', "wife's father", 'brother-in-law'],
    ['brother-in-law', "wife's brother", 'sister-in-law'],
    ['sister-in-law', "wife's sister", 'mother-in-law'],
  ];
  for (const [ownValue, form, otherValue] of compositionalCases) {
    const ownForms = getSurfaceForms('relation', ownValue);
    const otherForms = getSurfaceForms('relation', otherValue);
    check(`compositional: "${form}" registers only under ${ownValue}, not ${otherValue}`,
      ownForms.has(form) && !otherForms.has(form));
  }

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`\x1b[31m❌ evidenceRegistry: ${failures.length} failed\x1b[0m`);
    for (const f of failures) console.log(`   \x1b[31m✗ ${f}\x1b[0m`);
  } else {
    console.log(`\x1b[32m✅ evidenceRegistry: ${passed}/${total} — all green\x1b[0m`);
  }
  return { passed, failed: failures.length, total };
}
