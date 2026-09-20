// Natural Multi-Fact Interpretation V1 — propose → deterministic admit → hold.
// This module has NO database access, NO session/pending mutation, and NO
// write or CALL/SMS/Maps authority. Admitted candidates are RAM-only.

import { findStandardSpan } from '../hooks/llmLayers';
import { FAMILY_SYNONYMS } from '../utils/familyRead';
import { splitNarrativeSentences, TODO_ADD_PREFIX } from '../utils/instructionSignals';
import { MONTHS } from '../utils/parseTime';

export const MULTI_FACT_KINDS = [
  'person_relation',
  'preference',
  'intention',
  'event',
  'attributed_claim',
  'prescribed',
  'obligation',
  'temporal',
  'emotion_drop',
] as const;

export type MultiFactKind = (typeof MULTI_FACT_KINDS)[number];

export type MultiFactProposedCandidate = {
  kind: MultiFactKind;
  value: string;
  subject?: string;
  attribution?: string;
  hedge?: string;
  temporal?: string;
  contradictGroupId?: string;
};

export type MultiFactProposal = {
  episodeId: string;
  candidates: MultiFactProposedCandidate[];
};

export type AdmittedMultiFactCandidate = {
  kind: Exclude<MultiFactKind, 'emotion_drop'>;
  value: string;
  subject?: string;
  attribution?: string;
  hedge?: string;
  temporal?: string;
  contradictGroupId?: string;
  disposition: 'hold';
  episodeId: string;
};

export type MultiFactProposalGenerationResult =
  | { status: 'ok'; proposal: MultiFactProposal }
  | { status: 'parse_fail'; raw: string }
  | { status: 'unavailable'; reason: 'injected' | 'busy' | 'no_ctx' };

export type MultiFactAdmissionDecision =
  | { decision: 'ADMIT'; episodeId: string; candidates: AdmittedMultiFactCandidate[] }
  | { decision: 'DEFER'; reason: string };

const HEDGE_RE = /\b(might|maybe|looks like|not sure|i think|around|possibly)\b/i;
const EMOTION_CANCER_RE = /\bhope\b[\s\S]{0,80}\b(cancer|lymphoma)\b/i;
const PRESCRIBE_RE = /\b(prescription|prescribed|called(?:\s+me)?\s+in)\b/i;
const TAKING_RE = /\b(taking|currently taking|currently on)\b/i;
const CLINICAL_RE = /\b(lymphoma|cancer)\b/i;
const DATE_SPAN_RE = new RegExp(
  String.raw`\b(?:${MONTHS.join('|')})\s+\d{1,2}(?:st|nd|rd|th)?\b`,
  'gi',
);
const WEEKDAY_THE_RE =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+the\s+\d{1,2}(?:st|nd|rd|th)?\b/gi;

const FAMILY_KEYS = Object.keys(FAMILY_SYNONYMS).sort((a, b) => b.length - a.length);

export function parseMultiFactProposal(rawModelOutput: string): MultiFactProposal | null {
  const start = rawModelOutput.indexOf('{');
  const end = rawModelOutput.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawModelOutput.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.episodeId !== 'string' || !o.episodeId.trim()) return null;
  if (!Array.isArray(o.candidates)) return null;
  const candidates: MultiFactProposedCandidate[] = [];
  for (const item of o.candidates) {
    if (!item || typeof item !== 'object') return null;
    const c = item as Record<string, unknown>;
    if (typeof c.kind !== 'string' || !(MULTI_FACT_KINDS as readonly string[]).includes(c.kind)) {
      return null;
    }
    if (typeof c.value !== 'string' || !c.value.trim()) return null;
    const next: MultiFactProposedCandidate = {
      kind: c.kind as MultiFactKind,
      value: c.value,
    };
    if (c.subject !== undefined) {
      if (typeof c.subject !== 'string') return null;
      next.subject = c.subject;
    }
    if (c.attribution !== undefined) {
      if (typeof c.attribution !== 'string') return null;
      next.attribution = c.attribution;
    }
    if (c.hedge !== undefined) {
      if (typeof c.hedge !== 'string') return null;
      next.hedge = c.hedge;
    }
    if (c.temporal !== undefined) {
      if (typeof c.temporal !== 'string') return null;
      next.temporal = c.temporal;
    }
    if (c.contradictGroupId !== undefined) {
      if (typeof c.contradictGroupId !== 'string') return null;
      next.contradictGroupId = c.contradictGroupId;
    }
    candidates.push(next);
  }
  return { episodeId: o.episodeId.trim(), candidates };
}

function episodeIdFor(raw: string): string {
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(h, 31) + raw.charCodeAt(i)) | 0;
  return `nmf:${h >>> 0}`;
}

function uniqueSpans(raw: string, re: RegExp): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const copy = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = copy.exec(raw))) {
    const span = m[0];
    const key = span.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(span);
  }
  return out;
}

function familySubject(sentence: string): string | undefined {
  const lower = sentence.toLowerCase();
  for (const key of FAMILY_KEYS) {
    const re = new RegExp(`\\b${key.replace(/-/g, '[- ]')}\\b`, 'i');
    if (re.test(lower)) return key;
  }
  return undefined;
}

function extractHedge(sentence: string): string | undefined {
  const hit = sentence.match(HEDGE_RE);
  return hit ? hit[0] : undefined;
}

function extractAttribution(sentence: string): string | undefined {
  const dr = sentence.match(/\bDr\.?\s+[A-Z][a-zA-Z]+\b/);
  if (dr) return dr[0];
  if (/\bdermatologist\b/i.test(sentence)) return 'dermatologist';
  if (/\boncologist\b/i.test(sentence)) return 'oncologist';
  if (/\bshe said\b/i.test(sentence) || /\bhe said\b/i.test(sentence)) return 'attributed';
  return undefined;
}

function classifyKind(sentence: string): MultiFactKind {
  if (EMOTION_CANCER_RE.test(sentence)) return 'emotion_drop';
  if (PRESCRIBE_RE.test(sentence)) return 'prescribed';
  if (/\bmight\b/i.test(sentence) || /\blooks like\b/i.test(sentence)) return 'attributed_claim';
  if (/\bfavorite\b/i.test(sentence)) return 'preference';
  if (TODO_ADD_PREFIX.test(sentence) || /\bi need\b/i.test(sentence) || /\bi gotta\b/i.test(sentence)) {
    return 'obligation';
  }
  if (/\b(i(?:'| a)?m going to|i will|i'll)\b/i.test(sentence)) return 'intention';
  if (familySubject(sentence)) return 'person_relation';
  const dates = uniqueSpans(sentence, DATE_SPAN_RE);
  if (dates.length > 0 && /\b(get back|leave|return|anniversary|fly home)\b/i.test(sentence)) {
    return 'temporal';
  }
  return 'event';
}

/** Keep Dr./Mr. titles intact; splitNarrativeSentences otherwise treats "Dr." as a boundary. */
function splitMultiFactSentences(raw: string): string[] {
  const protectedText = raw.replace(/\b(Dr|Mr|Mrs|Ms|Prof)\./gi, '$1\u2024');
  return splitNarrativeSentences(protectedText).map((s) => s.replace(/\u2024/g, '.'));
}

export function proposeNaturalMultiFactFromUtterance(raw: string): MultiFactProposal {
  const episodeId = episodeIdFor(raw);
  const candidates: MultiFactProposedCandidate[] = [];
  for (const sentence of splitMultiFactSentences(raw)) {
    const kind = classifyKind(sentence);
    const dates = uniqueSpans(sentence, DATE_SPAN_RE);
    const hedge = extractHedge(sentence);
    const candidate: MultiFactProposedCandidate = {
      kind,
      value: sentence,
      subject: familySubject(sentence),
      attribution: extractAttribution(sentence),
      hedge,
      temporal: dates[0],
    };
    if (dates.length >= 2) {
      const group = `contradict:${episodeId}`;
      candidate.contradictGroupId = group;
      candidates.push(candidate);
      for (const d of dates) {
        candidates.push({
          kind: 'temporal',
          value: d,
          temporal: d,
          contradictGroupId: group,
          hedge,
        });
      }
      continue;
    }
    candidates.push(candidate);
  }
  const weekday = uniqueSpans(raw, WEEKDAY_THE_RE);
  for (const w of weekday) {
    if (candidates.some((c) => c.value.toLowerCase() === w.toLowerCase())) continue;
    candidates.push({ kind: 'temporal', value: w, temporal: w });
  }
  return { episodeId, candidates };
}

function groundOptional(raw: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const span = findStandardSpan(raw, value);
  return span ?? undefined;
}

export function admitNaturalMultiFactProposal(
  raw: string,
  proposal: MultiFactProposal,
): MultiFactAdmissionDecision {
  const admitted: AdmittedMultiFactCandidate[] = [];
  const episodeId = proposal.episodeId.trim();
  if (!episodeId) return { decision: 'DEFER', reason: 'missing_episode' };

  for (const c of proposal.candidates) {
    if (c.kind === 'emotion_drop') continue;
    const value = findStandardSpan(raw, c.value);
    if (!value) continue;
    if (c.kind === 'prescribed' && TAKING_RE.test(value) && !PRESCRIBE_RE.test(raw)) continue;
    if (CLINICAL_RE.test(value)) {
      const hedge = c.hedge ? findStandardSpan(raw, c.hedge) : extractHedge(value);
      if (!hedge) continue;
    }
    const kind = c.kind;
    admitted.push({
      kind,
      value,
      subject: groundOptional(raw, c.subject),
      attribution: groundOptional(raw, c.attribution) ?? (c.attribution === 'attributed' ? 'attributed' : undefined),
      hedge: groundOptional(raw, c.hedge) ?? extractHedge(value),
      temporal: groundOptional(raw, c.temporal),
      contradictGroupId: c.contradictGroupId,
      disposition: 'hold',
      episodeId,
    });
  }

  if (admitted.length < 2) {
    return { decision: 'DEFER', reason: `below_threshold:${admitted.length}` };
  }
  return { decision: 'ADMIT', episodeId, candidates: admitted };
}

export function visitInterceptShouldYieldToMultiFact(
  candidates: readonly AdmittedMultiFactCandidate[],
): boolean {
  return candidates.some((c) => c.kind !== 'event');
}

export function tryNaturalMultiFactHold(
  raw: string,
  opts: {
    enabled: boolean;
    propose?: (text: string) => MultiFactProposalGenerationResult;
    intercept: 'visit' | 'fallthrough';
  },
): { episodeId: string; candidates: AdmittedMultiFactCandidate[] } | null {
  if (!opts.enabled) return null;
  const generated = opts.propose
    ? opts.propose(raw)
    : { status: 'ok' as const, proposal: proposeNaturalMultiFactFromUtterance(raw) };
  if (generated.status !== 'ok') return null;
  const admitted = admitNaturalMultiFactProposal(raw, generated.proposal);
  if (admitted.decision !== 'ADMIT') return null;
  if (opts.intercept === 'visit' && !visitInterceptShouldYieldToMultiFact(admitted.candidates)) {
    return null;
  }
  return { episodeId: admitted.episodeId, candidates: admitted.candidates };
}
