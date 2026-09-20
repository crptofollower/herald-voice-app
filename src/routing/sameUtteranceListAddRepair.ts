// Same-Utterance Self-Repair V1 — bounded list-add supersession interpreter.
//
// Contract: provisional candidate(s) → one repair boundary/operation → replacement
// candidate(s). Not a writer. Not an open phrase catalog. Trailing speech after
// "to … list" is inspected only when it opens with a repair operator.

export const UNRESOLVED_LIST_ADD_SUPERSESSION_REASON = 'unresolved_list_add_supersession';

export type ListAddSupersession =
  | { kind: 'none' }
  | { kind: 'resolved'; items: string[] }
  | { kind: 'unresolved' };

const LEAD_PUNCT_RE = /^[\s,.;:!?-]+/;
const CUE_RE = /^(actually|wait|sorry|no)\b/i;
const MAKE_THAT_RE = /^make\s+that\b/i;
const MAKE_THE_RE = /^make\s+the\b/i;
const JUST_RE = /^just\b/i;
const CUE_ONLY_RE = /^(?:actually|wait|sorry|no)$/i;
const IN_SPAN_BOUNDARY_RE =
  /(?:\s+|\s*-\s*|\s*\.\.\.\s*)(?:(?:actually|wait|sorry)\b|make\s+that\b|make\s+the\b|just\b)/i;
const SECOND_BOUNDARY_RE =
  /(?:\s+|\s*-\s*|\s*\.\.\.\s*)(?:(?:actually|wait|sorry|no)\b|make\s+that\b|make\s+the\b|just\b)/i;

const ITEM_SPLIT_RE = /\s*,\s*|\s+and\s+/i;

export function splitListAddItemSpan(raw: string): string[] {
  return raw
    .split(ITEM_SPLIT_RE)
    .map((s) => s.replace(/[.!?]+$/g, '').trim())
    .filter((s) => s.length > 0);
}

function stripLeadPunct(text: string): string {
  return text.replace(LEAD_PUNCT_RE, '').trim();
}

function remainderOpensRepair(remainder: string): boolean {
  const t = stripLeadPunct(remainder);
  if (!t) return false;
  return CUE_RE.test(t) || MAKE_THAT_RE.test(t) || MAKE_THE_RE.test(t) || JUST_RE.test(t);
}

function hasSecondBoundary(text: string): boolean {
  return SECOND_BOUNDARY_RE.test(` ${text.trim()}`);
}

function uniqueKeepSubset(
  provisionals: readonly string[],
  replacements: readonly string[],
): string[] | null {
  const wanted = replacements.map((r) => r.trim().replace(/[.!?]+$/g, '').toLowerCase());
  if (wanted.some((w) => !w)) return null;
  const kept: string[] = [];
  for (const p of provisionals) {
    const key = p.trim().replace(/[.!?]+$/g, '').toLowerCase();
    if (wanted.includes(key)) kept.push(p.trim().replace(/[.!?]+$/g, ''));
  }
  if (kept.length !== wanted.length) return null;
  const keptKeys = kept.map((k) => k.toLowerCase());
  if (wanted.some((w) => !keptKeys.includes(w))) return null;
  return kept;
}

function longestUniquePrefixIndex(
  provisionals: readonly string[],
  rest: string,
): { index: number; consumed: string } | null {
  const lower = rest.trim().toLowerCase();
  const hits: Array<{ index: number; consumed: string }> = [];
  for (let i = 0; i < provisionals.length; i++) {
    const p = provisionals[i].trim().replace(/[.!?]+$/g, '');
    if (!p) continue;
    const pl = p.toLowerCase();
    if (!lower.startsWith(pl)) continue;
    const after = rest.trim().slice(p.length);
    if (after.length > 0 && !/^\s/.test(after)) continue;
    hits.push({ index: i, consumed: p });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.consumed.length - a.consumed.length);
  if (hits.length > 1 && hits[0].consumed.length === hits[1].consumed.length) return null;
  return hits[0];
}

function parseRepairClause(
  clause: string,
  provisionals: readonly string[],
): ListAddSupersession {
  let rest = stripLeadPunct(clause);
  if (!rest) return { kind: 'unresolved' };

  let hadCue = false;
  if (CUE_RE.test(rest)) {
    hadCue = true;
    rest = stripLeadPunct(rest.replace(CUE_RE, ''));
    if (CUE_RE.test(rest)) return { kind: 'unresolved' };
  }

  let op: 'whole' | 'that' | 'member' | 'just' = 'whole';
  if (MAKE_THAT_RE.test(rest)) {
    op = 'that';
    rest = stripLeadPunct(rest.replace(MAKE_THAT_RE, ''));
  } else if (MAKE_THE_RE.test(rest)) {
    op = 'member';
    rest = stripLeadPunct(rest.replace(MAKE_THE_RE, ''));
  } else if (JUST_RE.test(rest)) {
    op = 'just';
    rest = stripLeadPunct(rest.replace(JUST_RE, ''));
  }

  if (!hadCue && op === 'whole') return { kind: 'unresolved' };
  if (!rest) return { kind: 'unresolved' };
  if (hasSecondBoundary(rest)) return { kind: 'unresolved' };

  if (op === 'member') {
    const hit = longestUniquePrefixIndex(provisionals, rest);
    if (!hit) return { kind: 'unresolved' };
    const replacementRaw = stripLeadPunct(rest.trim().slice(hit.consumed.length));
    if (!replacementRaw || hasSecondBoundary(replacementRaw)) return { kind: 'unresolved' };
    const replacement = splitListAddItemSpan(replacementRaw);
    if (replacement.length !== 1) return { kind: 'unresolved' };
    const next = [...provisionals];
    next[hit.index] = replacement[0];
    return { kind: 'resolved', items: next };
  }

  const replacements = splitListAddItemSpan(rest);
  if (replacements.length === 0) return { kind: 'unresolved' };

  if (op === 'that') {
    if (provisionals.length !== 1) return { kind: 'unresolved' };
    return { kind: 'resolved', items: replacements };
  }

  if (op === 'just') {
    const kept = uniqueKeepSubset(provisionals, replacements);
    if (!kept) return { kind: 'unresolved' };
    return { kind: 'resolved', items: kept };
  }

  if (provisionals.length === 1) return { kind: 'resolved', items: replacements };
  if (replacements.length >= 2) return { kind: 'resolved', items: replacements };
  return { kind: 'unresolved' };
}

function inSpanRepairSplit(captureRaw: string): { before: string; clause: string } | 'unresolved' | null {
  const raw = captureRaw.trim();
  if (!raw) return null;

  const segments = raw.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const cueIndexes = segments
    .map((s, i) => (i > 0 && CUE_ONLY_RE.test(s) ? i : -1))
    .filter((i) => i >= 0);
  if (cueIndexes.length > 1) return 'unresolved';
  if (cueIndexes.length === 1) {
    const i = cueIndexes[0];
    const before = segments.slice(0, i).join(', ');
    const clause = segments.slice(i).join(', ');
    if (!before.trim()) return 'unresolved';
    return { before, clause };
  }

  const boundary = IN_SPAN_BOUNDARY_RE.exec(raw);
  if (!boundary || boundary.index <= 0) return null;
  const before = raw.slice(0, boundary.index).trim();
  const clause = raw.slice(boundary.index).trim();
  if (!before) return null;
  return { before, clause };
}

export function interpretSameUtteranceListAddSupersession(args: {
  captureRaw: string;
  remainder: string;
  provisionalItems: readonly string[];
}): ListAddSupersession {
  const remainder = args.remainder ?? '';
  const captureRaw = args.captureRaw ?? '';

  if (remainderOpensRepair(remainder)) {
    const provisionals = args.provisionalItems.length > 0
      ? [...args.provisionalItems]
      : splitListAddItemSpan(captureRaw);
    if (provisionals.length === 0) return { kind: 'unresolved' };
    if (inSpanRepairSplit(captureRaw) != null) return { kind: 'unresolved' };
    return parseRepairClause(remainder, provisionals);
  }

  const inSpan = inSpanRepairSplit(captureRaw);
  if (inSpan === 'unresolved') return { kind: 'unresolved' };
  if (inSpan) {
    const provisionals = splitListAddItemSpan(inSpan.before);
    if (provisionals.length === 0) return { kind: 'unresolved' };
    return parseRepairClause(inSpan.clause, provisionals);
  }

  return { kind: 'none' };
}
