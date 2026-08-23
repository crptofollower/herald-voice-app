// Shared ReadIntent contract (HERALD_READ_ARCHITECTURE_DESIGN_SPEC v3, ratified).
// Classification only — answers come exclusively from deterministic domain readers.

import {
  answerHouseholdRead,
  type HouseholdReadIntent,
  INSURANCE_SYNONYMS,
  LEGAL_TYPES,
  SERVICE_SYNONYMS,
} from '../utils/householdRead';
import { findStandardSpan } from '../hooks/llmLayers';

// ─── Closed registries (§4d) ───────────────────────────────────────────────────

export const READ_DOMAINS = ['HOUSEHOLD'] as const;
export type ReadDomain = typeof READ_DOMAINS[number];

export const READ_ENTITY_TYPES = [
  'service_provider',
  'insurance',
  'legal_document',
] as const;
export type ReadEntityType = typeof READ_ENTITY_TYPES[number];

export const REQUESTED_INFORMATION = [
  'EXISTENCE',
  'IDENTITY',
  'LOCATION',
  'CONTACT',
  'STATUS',
  'ENUMERATION',
] as const;
export type RequestedInformation = typeof REQUESTED_INFORMATION[number];

export type ReadIntent = {
  operation: 'READ';
  domain: ReadDomain;
  entity_type: ReadEntityType;
  entity: string;
  requested_information: RequestedInformation;
  raw_phrase: string;
  confidence: 'high' | 'low';
};

export type ReadIntentMeta = {
  readIntents: ReadIntent[];
  /** True when the classifier emitted any type:"read" object — terminal locally (§4d). */
  readLabeled: boolean;
};

const READ_DOMAINS_SET = new Set<string>(READ_DOMAINS);
const READ_ENTITY_TYPES_SET = new Set<string>(READ_ENTITY_TYPES);
const REQUESTED_INFORMATION_SET = new Set<string>(REQUESTED_INFORMATION);

const HOUSEHOLD_DISPATCH: ReadEntityType[] = [
  'service_provider',
  'insurance',
  'legal_document',
];

export const READ_CLARIFY_DEFAULT =
  "I'm not sure I'm following you — can you help me understand?";

// ─── Validation (membership only — never rewrite) ────────────────────────────

export function validateReadIntent(intent: ReadIntent): ReadIntent | null {
  if (intent.operation !== 'READ') return null;
  if (!READ_DOMAINS_SET.has(intent.domain)) return null;
  if (!READ_ENTITY_TYPES_SET.has(intent.entity_type)) return null;
  if (!REQUESTED_INFORMATION_SET.has(intent.requested_information)) return null;
  if (intent.confidence !== 'high' && intent.confidence !== 'low') return null;
  if (!intent.entity?.trim()) return null;
  if (!intent.raw_phrase?.trim()) return null;
  return intent;
}

export function buildReadClarification(intents: Array<{ entity?: string }>): string {
  const entity = intents[0]?.entity?.trim();
  if (!entity) return READ_CLARIFY_DEFAULT;
  return `Are you asking about your ${entity}?`;
}

// ─── Classifier parse (type:"read" → ReadIntent) ─────────────────────────────

/** TEMP — device ReadIntent A/B diagnostic (additive logging only). */
export const READ_INTENT_PARSE_RAW_MAX = 512;

export type ReadIntentDropReason =
  | 'invalid_registry'
  | 'low_confidence'
  | 'verbatim_entity_grounding_failure'
  | 'other_parse_rejection';

export type ReadIntentDroppedRecord = {
  reason: ReadIntentDropReason;
  /** Classifier-proposed entity label only — never stored Household values. */
  entity?: string;
};

export type ReadIntentParseDiagnostic = {
  rawJson: string | null;
  readLabeled: boolean;
  parsedCount: number;
  dropped: ReadIntentDroppedRecord[];
};

type ClassifierReadRecord = {
  type: 'read';
  domain: string;
  entity_type: string;
  entity: string;
  requested_information: string;
  raw_phrase: string;
  confidence: string;
};

/** Locate a registry key's grounded surface span and start index in the utterance. */
function locateRegistrySpan(
  rawUtterance: string,
  registryKey: string,
): { span: string; start: number; end: number } | null {
  const span = findStandardSpan(rawUtterance, registryKey);
  if (!span) return null;
  let start = rawUtterance.indexOf(span);
  if (start < 0) {
    const lower = rawUtterance.toLowerCase();
    const idx = lower.indexOf(span.toLowerCase());
    if (idx < 0) return null;
    start = idx;
    return { span: rawUtterance.slice(start, start + span.length), start, end: start + span.length };
  }
  return { span, start, end: start + span.length };
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return !(a.end <= b.start || a.start >= b.end);
}

function registryKeysForEntityType(entityType: ReadEntityType): string[] {
  switch (entityType) {
    case 'service_provider':
      return Object.keys(SERVICE_SYNONYMS);
    case 'insurance':
      return Object.keys(INSURANCE_SYNONYMS);
    case 'legal_document':
      return [...LEGAL_TYPES];
    default:
      return [];
  }
}

/** Non-overlapping registry-grounded spans in utterance order (longest key wins ties). */
export function findGroundedEntitySpansForType(
  rawUtterance: string,
  entityType: ReadEntityType,
): string[] {
  const keys = registryKeysForEntityType(entityType)
    .sort((a, b) => b.length - a.length);
  const occupied: Array<{ start: number; end: number }> = [];
  const hits: Array<{ span: string; start: number }> = [];

  for (const key of keys) {
    const located = locateRegistrySpan(rawUtterance, key);
    if (!located) continue;
    if (occupied.some((o) => rangesOverlap(o, located))) continue;
    occupied.push({ start: located.start, end: located.end });
    hits.push({ span: located.span, start: located.start });
  }

  return hits.sort((a, b) => a.start - b.start).map((h) => h.span);
}

function precomputeGroundedSpansByType(
  rawUtterance: string,
): Map<ReadEntityType, string[]> {
  const map = new Map<ReadEntityType, string[]>();
  for (const entityType of READ_ENTITY_TYPES) {
    map.set(entityType, findGroundedEntitySpansForType(rawUtterance, entityType));
  }
  return map;
}

function deriveDeterministicReadEntity(
  entityType: ReadEntityType,
  spansByType: Map<ReadEntityType, string[]>,
  readCountsByType: Map<ReadEntityType, number>,
): string | null {
  const readCount = readCountsByType.get(entityType) ?? 0;
  const spans = spansByType.get(entityType) ?? [];
  // V1: same-type compound reads fail closed — no classifier-order attribution.
  if (readCount !== 1 || spans.length !== 1) return null;
  return spans[0];
}

function verifyReadVerbatim(
  rec: ClassifierReadRecord,
  rawUtterance: string,
  spansByType: Map<ReadEntityType, string[]>,
  readCountsByType: Map<ReadEntityType, number>,
): ClassifierReadRecord | null {
  if (!READ_ENTITY_TYPES_SET.has(rec.entity_type)) return null;
  const entityType = rec.entity_type as ReadEntityType;
  const entity = deriveDeterministicReadEntity(
    entityType,
    spansByType,
    readCountsByType,
  );
  if (!entity) return null;
  return { ...rec, entity, raw_phrase: rawUtterance };
}

function truncateReadIntentRaw(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  if (trimmed.length <= READ_INTENT_PARSE_RAW_MAX) return trimmed;
  return `${trimmed.slice(0, READ_INTENT_PARSE_RAW_MAX)}…`;
}

function parseReadIntentsFromClassifierInternal(
  rawText: string,
  rawUtterance: string,
): { meta: ReadIntentMeta; diagnostic: ReadIntentParseDiagnostic } {
  const diagnostic: ReadIntentParseDiagnostic = {
    rawJson: truncateReadIntentRaw(rawText),
    readLabeled: false,
    parsedCount: 0,
    dropped: [],
  };

  const arrStr = rawText.match(/\[[\s\S]*\]/)?.[0];
  if (!arrStr) return { meta: { readIntents: [], readLabeled: false }, diagnostic };
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrStr);
  } catch {
    return { meta: { readIntents: [], readLabeled: false }, diagnostic };
  }
  if (!Array.isArray(parsed)) return { meta: { readIntents: [], readLabeled: false }, diagnostic };

  const pendingReads: Array<{
    candidate: ClassifierReadRecord;
    proposedEntity?: string;
  }> = [];

  for (const el of parsed.slice(0, 4)) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
    const rec = el as Record<string, unknown>;
    if (rec.type !== 'read') continue;
    diagnostic.readLabeled = true;
    const proposedEntity =
      typeof rec.entity === 'string' && rec.entity.trim() ? rec.entity.trim() : undefined;
    pendingReads.push({
      candidate: rec as unknown as ClassifierReadRecord,
      proposedEntity,
    });
  }

  const readLabeled = diagnostic.readLabeled;
  const spansByType = precomputeGroundedSpansByType(rawUtterance);
  const readCountsByType = new Map<ReadEntityType, number>();
  for (const pending of pendingReads) {
    const et = pending.candidate.entity_type;
    if (!READ_ENTITY_TYPES_SET.has(et)) continue;
    const entityType = et as ReadEntityType;
    readCountsByType.set(entityType, (readCountsByType.get(entityType) ?? 0) + 1);
  }

  const readIntents: ReadIntent[] = [];

  for (const { candidate, proposedEntity } of pendingReads) {
    try {
      const verified = verifyReadVerbatim(
        candidate,
        rawUtterance,
        spansByType,
        readCountsByType,
      );
      if (!verified) {
        diagnostic.dropped.push({
          reason: 'verbatim_entity_grounding_failure',
          ...(proposedEntity ? { entity: proposedEntity } : {}),
        });
        continue;
      }
      const intent: ReadIntent = {
        operation: 'READ',
        domain: verified.domain as ReadDomain,
        entity_type: verified.entity_type as ReadEntityType,
        entity: verified.entity,
        requested_information: verified.requested_information as RequestedInformation,
        raw_phrase: verified.raw_phrase,
        confidence: verified.confidence as 'high' | 'low',
      };
      const validated = validateReadIntent(intent);
      if (!validated) {
        diagnostic.dropped.push({
          reason: 'invalid_registry',
          ...(proposedEntity ? { entity: proposedEntity } : {}),
        });
        continue;
      }
      readIntents.push(validated);
    } catch {
      diagnostic.dropped.push({
        reason: 'other_parse_rejection',
        ...(proposedEntity ? { entity: proposedEntity } : {}),
      });
      continue;
    }
  }
  diagnostic.parsedCount = readIntents.length;
  return { meta: { readIntents, readLabeled }, diagnostic };
}

/** Parse ReadIntent[] from classifier JSON array text. */
export function parseReadIntentsFromClassifier(
  rawText: string,
  rawUtterance: string,
): ReadIntentMeta {
  return parseReadIntentsFromClassifierInternal(rawText, rawUtterance).meta;
}

/** TEMP — parse + diagnostic sidecar for device A/B tracing (behavior identical to parseReadIntentsFromClassifier). */
export function parseReadIntentsFromClassifierWithDiagnostic(
  rawText: string,
  rawUtterance: string,
): { meta: ReadIntentMeta; diagnostic: ReadIntentParseDiagnostic } {
  return parseReadIntentsFromClassifierInternal(rawText, rawUtterance);
}

// ─── Household dispatch adapter ──────────────────────────────────────────────

function resolveLegalEntity(spoken: string): string | null {
  const lower = spoken.toLowerCase();
  const hit = [...LEGAL_TYPES].sort((a, b) => b.length - a.length)
    .find((t) => lower.includes(t));
  return hit ?? null;
}

export function readIntentToHousehold(intent: ReadIntent): HouseholdReadIntent | null {
  if (intent.domain !== 'HOUSEHOLD') return null;
  if (!HOUSEHOLD_DISPATCH.includes(intent.entity_type)) return null;

  const spokenKey = intent.entity.trim().toLowerCase();

  if (intent.entity_type === 'service_provider') {
    const categories = SERVICE_SYNONYMS[spokenKey] ?? [spokenKey];
    return { type: 'service_provider', categories, spoken: intent.entity.trim() };
  }
  if (intent.entity_type === 'insurance') {
    const categories = INSURANCE_SYNONYMS[spokenKey] ?? [spokenKey];
    return { type: 'insurance', categories, spoken: intent.entity.trim() };
  }
  if (intent.entity_type === 'legal_document') {
    const docType = resolveLegalEntity(intent.entity);
    if (!docType) return null;
    return { type: 'legal_document', categories: [docType], spoken: docType };
  }
  return null;
}

function dispatchOneReadIntent(intent: ReadIntent): string | null {
  if (!HOUSEHOLD_DISPATCH.includes(intent.entity_type)) return null;
  const household = readIntentToHousehold(intent);
  if (!household) return null;
  return answerHouseholdRead(household);
}

export type ReadDispatchOutcome =
  | { status: 'answered'; responseText: string }
  | { status: 'clarify'; responseText: string }
  | { status: 'none' };

/** Shared handler — loops ReadIntent[], never returns after first element (§4b). */
export function dispatchReadIntents(
  readIntents: ReadIntent[],
  opts: { readLabeled?: boolean } = {},
): ReadDispatchOutcome {
  if (readIntents.length === 0) {
    if (opts.readLabeled) {
      return { status: 'clarify', responseText: READ_CLARIFY_DEFAULT };
    }
    return { status: 'none' };
  }

  const answers: string[] = [];
  for (const intent of readIntents) {
    const validated = validateReadIntent(intent);
    if (!validated) {
      return { status: 'clarify', responseText: buildReadClarification([intent]) };
    }
    if (validated.confidence === 'low') {
      return { status: 'clarify', responseText: buildReadClarification([validated]) };
    }
    const answer = dispatchOneReadIntent(validated);
    if (answer === null) {
      return { status: 'clarify', responseText: buildReadClarification([validated]) };
    }
    answers.push(answer);
  }
  return { status: 'answered', responseText: answers.join(' ') };
}

export function hasHouseholdDispatchRow(entityType: ReadEntityType): boolean {
  return HOUSEHOLD_DISPATCH.includes(entityType);
}
