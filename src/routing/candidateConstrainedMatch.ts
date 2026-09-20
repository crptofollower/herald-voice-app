/**
 * Candidate-constrained identity repair for Call/Text pending disambiguation.
 * Ranks only the active finite candidate set. Never invents a name, never
 * authorizes a recipient — callers must confirm any non-exact proposal.
 */

export type ConstrainedProposal =
  | { kind: 'none' }
  | { kind: 'one'; name: string }
  | { kind: 'two'; names: [string, string] };

function normalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function concatKey(raw: string): string {
  return normalizeKey(raw).replace(/\s+/g, '');
}

function tokens(raw: string): string[] {
  return normalizeKey(raw).split(' ').filter(t => t.length > 0);
}

/**
 * Longest contiguous run of single alphabetic tokens (length >= 3).
 * Structural spelling only — no name-specific patterns. Callers feed the
 * concat through the same finite-set proposer; this never invents a name.
 */
export function structuralSpellingConcat(raw: string): string | null {
  const toks = tokens(raw);
  let best = '';
  let run = '';
  const flush = () => {
    if (run.length >= 3 && run.length > best.length) best = run;
    run = '';
  };
  for (const t of toks) {
    if (t.length === 1 && /[a-z]/.test(t)) run += t;
    else flush();
  }
  flush();
  return best || null;
}

function lastName(full: string): string {
  const t = tokens(full);
  return t[t.length - 1] ?? '';
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Classic American Soundex, 4-character. */
export function soundex(raw: string): string {
  const s = concatKey(raw).toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const first = s[0];
  const code = (c: string): string => {
    if ('BFPV'.includes(c)) return '1';
    if ('CGJKQSXZ'.includes(c)) return '2';
    if ('DT'.includes(c)) return '3';
    if (c === 'L') return '4';
    if ('MN'.includes(c)) return '5';
    if (c === 'R') return '6';
    return '0';
  };
  let out = first;
  let prev = code(first);
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const n = code(s[i]);
    if (n !== '0' && n !== prev) out += n;
    if (n !== '0') prev = n;
  }
  return (out + '000').slice(0, 4);
}

function consonantSkeleton(raw: string): string {
  const c = concatKey(raw);
  if (!c) return '';
  return c[0] + c.slice(1).replace(/[aeiouy]/g, '');
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Propose 0, 1, or 2 names from `candidates` only.
 * Exact token/last-name identity is handled upstream; this path is for
 * imperfect capture against that same closed set.
 *
 * A winner is "separated" when it is the only name that satisfies a
 * discrete structural signal (exact last-name / unique suffix-or-prefix
 * token / unique soundex / unique close edit). No floating threshold.
 */
export function proposeConstrainedCandidate(
  reply: string,
  candidates: string[],
): ConstrainedProposal {
  const names = unique(candidates.map(n => n.trim()).filter(Boolean));
  if (names.length < 1 || !reply.trim()) return { kind: 'none' };

  const spelling = structuralSpellingConcat(reply);
  const replyForMatch = spelling ?? reply;
  const replyTokens = tokens(replyForMatch).filter(t => t.length >= 3);
  const replyConcat = concatKey(replyForMatch);
  if (!replyConcat && replyTokens.length === 0) return { kind: 'none' };

  const last = (n: string) => concatKey(lastName(n));

  // Exact last-name or exact concatenated last-name after space-strip.
  const exactLast = names.filter(n => last(n) === replyConcat && last(n).length > 0);
  if (exactLast.length === 1) return { kind: 'one', name: exactLast[0] };
  if (exactLast.length === 2) return { kind: 'two', names: [exactLast[0], exactLast[1]] };

  // Unique reply token is prefix or suffix of exactly one last name (len>=3).
  const tokenHits: string[] = [];
  for (const tok of replyTokens) {
    const hit = names.filter(n => {
      const ln = last(n);
      return ln.startsWith(tok) || ln.endsWith(tok) || ln.includes(tok);
    });
    if (hit.length === 1) tokenHits.push(hit[0]);
    if (hit.length === 2 && tok.length >= 4) {
      return { kind: 'two', names: [hit[0], hit[1]] };
    }
  }
  const tokenUnique = unique(tokenHits);
  if (tokenUnique.length === 1) return { kind: 'one', name: tokenUnique[0] };
  if (tokenUnique.length === 2) return { kind: 'two', names: [tokenUnique[0], tokenUnique[1]] };

  // Token within edit distance 1 of a last-name suffix of the same length.
  const nearSuffix: string[] = [];
  for (const tok of replyTokens) {
    if (tok.length < 4) continue;
    const hit = names.filter(n => {
      const ln = last(n);
      if (ln.length < tok.length) return levenshtein(tok, ln) <= 1;
      const suffix = ln.slice(-tok.length);
      return levenshtein(tok, suffix) <= 1;
    });
    if (hit.length === 1) nearSuffix.push(hit[0]);
  }
  const nearUnique = unique(nearSuffix);
  if (nearUnique.length === 1) return { kind: 'one', name: nearUnique[0] };
  if (nearUnique.length === 2) return { kind: 'two', names: [nearUnique[0], nearUnique[1]] };

  // Unique Soundex of last name vs concatenated reply, surname length >= 5.
  if (replyConcat.length >= 4) {
    const sx = soundex(replyConcat);
    const sxHits = names.filter(n => last(n).length >= 5 && soundex(last(n)) === sx);
    if (sxHits.length === 1) return { kind: 'one', name: sxHits[0] };
    if (sxHits.length === 2) return { kind: 'two', names: [sxHits[0], sxHits[1]] };
  }

  // Unique consonant skeleton, length >= 4.
  const sk = consonantSkeleton(replyConcat);
  if (sk.length >= 4) {
    const skHits = names.filter(n => consonantSkeleton(last(n)) === sk);
    if (skHits.length === 1) return { kind: 'one', name: skHits[0] };
    if (skHits.length === 2) return { kind: 'two', names: [skHits[0], skHits[1]] };
  }

  // Close unique edit to last name: distance <= 2, last name >= 4, runner-up
  // at least 2 farther (clear separation, not a score cutoff).
  // A singleton set has no runner-up: do not treat "closest of one" as a signal.
  if (replyConcat.length >= 4 && names.length >= 2) {
    const ranked = names
      .map(n => ({ n, d: levenshtein(replyConcat, last(n)) }))
      .sort((a, b) => a.d - b.d);
    const best = ranked[0];
    const second = ranked[1];
    if (
      best &&
      last(best.n).length >= 4 &&
      best.d <= 2 &&
      second &&
      second.d >= best.d + 2
    ) {
      return { kind: 'one', name: best.n };
    }
    if (best && second && best.d <= 2 && second.d === best.d && last(best.n).length >= 4) {
      return { kind: 'two', names: [best.n, second.n] };
    }
  }

  return { kind: 'none' };
}
