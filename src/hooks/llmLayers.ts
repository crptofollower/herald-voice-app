// src/hooks/llmLayers.ts
// On-device intent classification for Herald.
//
// Layer 1 — classifyWithLLM: messy speech → structured IntentRecord JSON
//   Temperature 0, n_predict 256, 5s timeout.
//   Falls back to null on any failure — caller uses tierRouter regex as fallback.
//
// MedicalEvent import kept minimal — type only, no runtime dependency.

import type { LlamaContext } from 'llama.rn';
import {
  beginCtxCompletion,
  endCtxCompletion,
  getActiveTurnId,
  getPrevCtxCompletionMeta,
  log as latLog,
  mono as latMono,
  type CtxCompletionConsumer,
} from '../utils/latencyInstrument';
import {
  maybeLoadCanonicalClassifierSessionBeforeClassify,
  saveCanonicalClassifierSessionWhileHoldingExclusive,
  type CanonicalSessionModelIdentity,
} from '../utils/canonicalClassifierSession';
import {
  isLlamaContextBusy,
  withLlamaContextExclusive,
} from '../utils/llamaContextExclusive';
import { SERVICE_SYNONYMS, INSURANCE_SYNONYMS } from '../utils/householdRead';
import { FAMILY_SYNONYMS } from '../utils/familyRead';
import { getSurfaceForms, IN_SCOPE_FIELDS, type RoutingFieldName } from '../utils/evidenceRegistry';
import { CLASSIFIER_RESPONSE_FORMAT } from './classifierJsonSchema';
import { parseReadIntentsFromClassifierWithDiagnostic } from '../routing/readIntent';

// ─── Intent types ─────────────────────────────────────────────────────────────

export type IntentRecord =
  | { type: 'list_add'; items: string[]; listName: string }
  | { type: 'insurance_capture'; insType: string; carrier: string; agent?: string; phone?: string }
  | { type: 'medical_capture'; drug?: string; dosage?: string; frequency?: string; raw: string }
  | { type: 'medical_visit'; doctor_name?: string; specialty?: string; advice?: string; raw: string }
  | { type: 'medical_visit_upcoming'; doctor_name?: string; specialty?: string; raw: string }
  | { type: 'doctor_intro_capture'; name: string; specialty: string; raw: string }
  | { type: 'service_capture'; category: string; name: string; phone?: string }
  | { type: 'family_capture'; relation: string; name: string; location?: string; phone?: string }
  | { type: 'phone_capture'; name: string; phone: string; relationship?: string }
  | { type: 'address_capture'; name: string; address: string }
  | { type: 'emergency_contact'; name: string; phone?: string }
  | { type: 'diagnosis_capture'; condition: string; raw: string }
  | { type: 'contact_call'; contact: string;
      candidates?: Array<{ name: string; relationship?: string; phone: string; importance: number }>;
      phonelessNames?: string[];
      devicePhone?: string; deviceName?: string; raw: string }
  | { type: 'todo_add'; body: string }
  | { type: 'todo_complete'; raw: string }
  | { type: 'pass' };

// Classifier-surviving types only. `todo_complete` is deterministic capture
// (P4c: never LLM vocabulary) and is therefore omitted from this set.
const KNOWN_TYPES = new Set<IntentRecord['type']>([
  'list_add', 'insurance_capture', 'medical_capture',
  'medical_visit', 'medical_visit_upcoming', 'doctor_intro_capture',
  'service_capture', 'family_capture', 'phone_capture', 'address_capture',
  'emergency_contact', 'diagnosis_capture', 'contact_call',
  'todo_add', 'pass',
]);

const STEP_FORMS = [
  'stepson', 'stepdaughter', 'stepmother', 'stepfather',
  'stepbrother', 'stepsister',
]; // SESSION_W W3c: FAMILY_SYNONYMS ∪ step forms

export type ClassifyOutcome =
  | { status: 'ok'; intents: IntentRecord[]; readIntents?: ReadIntent[]; readLabeled?: boolean }
  | { status: 'not_ready'; reason: 'in-flight' | 'no-ctx' }
  | { status: 'failed'; reason: 'completion_error' };

// Exclusive ownership of the shared LlamaContext is in llamaContextExclusive.ts.
// classifyWithLLM claims via withLlamaContextExclusive('classifier','try') —
// heldBy is set synchronously before any await inside that helper.
//
// The timeout was deleted deliberately: stopCompletion is inert during
// prefill (llama.cpp only checks its stop flag in the token-generation loop).
// A timeout that cannot cancel only abandons the promise and strands the
// exclusive hold, killing the classifier for the whole session.

// PARKED-FOR-REMOVAL: thin alias for pre-gate call sites / tests. Prefer
// isLlamaContextBusy(). Do not treat this as the permanent API.
export function isClassifierBusy(): boolean {
  return isLlamaContextBusy();
}

function extractJsonObject(raw: string): string | null {
  const m = raw.match(/\{[\s\S]*\}/);
  return m?.[0] ?? null;
}

export function extractJsonArray(raw: string): string | null {
  // Prefer a top-level / prose array of objects. Nested arrays inside a bare
  // object (e.g. items:["apples"]) must not win over W2b object-wrap.
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr?.[0]) {
    try {
      const parsed = JSON.parse(arr[0]);
      if (
        Array.isArray(parsed)
        && (parsed.length === 0
          || parsed.some(el => el !== null && typeof el === 'object' && !Array.isArray(el)))
      ) {
        return arr[0];
      }
    } catch {
      // fall through to bare-object wrap
    }
  }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj?.[0]) return `[${obj[0]}]`;
  return null;
}

export type ClassifierVocab = {
  knownLists: string[];      // caller passes hints.lists
  categories: Set<string>;   // will compile from SERVICE_SYNONYMS values
  insTypes: Set<string>;     // will compile from INSURANCE_SYNONYMS values
  relations: Set<string>;    // will compile from FAMILY_SYNONYMS keys+values + step forms
};

export function buildClassifierVocab(knownLists: string[]): ClassifierVocab {
  const categories = new Set<string>();
  for (const vals of Object.values(SERVICE_SYNONYMS)) {
    for (const v of vals) categories.add(v.toLowerCase());
  }
  const insTypes = new Set<string>();
  for (const vals of Object.values(INSURANCE_SYNONYMS)) {
    for (const v of vals) insTypes.add(v.toLowerCase());
  }
  const relations = new Set<string>();
  for (const [k, vals] of Object.entries(FAMILY_SYNONYMS)) {
    relations.add(k.toLowerCase());
    for (const v of vals) relations.add(v.toLowerCase());
  }
  for (const s of STEP_FORMS) relations.add(s.toLowerCase());
  return { knownLists, categories, insTypes, relations };
}

const ROUTING_FIELDS = new Set(['type', 'listName', 'category', 'insType', 'relation']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Unicode-aware "independent token/phrase" boundary. NOT native \b (ASCII-\w
// only). Token-internal set: letters, combining marks (so a decomposed
// accented character like e + U+0301 cannot leave a false boundary
// mid-character), digits, connector punctuation, and the Unicode DASH
// PUNCTUATION category (covers ASCII hyphen plus en/em dash and other
// Unicode dash forms as one category, not an enumerated list) -- so
// "Connor" cannot ground against "O'Connor" and "law"/"Smith" cannot ground
// against "father-in-law"/"Smith-Jones". Apostrophe forms are the one
// enumerated exception (no punctuation category isolates them without also
// swallowing real sentence punctuation). A period/comma/colon/slash is only
// non-boundary between two digits (preserves "20" failing to ground against
// "20.5" -- dosage-truncation safety).
//
// FAILS CLOSED if this runtime's regex engine doesn't support the full set
// of features the matcher below depends on: grounding is refused entirely
// (findStandardSpan returns null for everything) rather than silently
// falling back to unguarded substring matching. A legitimate capture may be
// lost on an unsupported runtime; a fabricated/partial capture may never
// gain authority. The feature check below exercises the SAME WORD_CHAR /
// boundaryWrap construction production actually uses -- not a minimal proxy
// -- so a partial-feature-support runtime (e.g. \p{L} works but \p{Pd} or
// lookbehind doesn't) is caught before findStandardSpan ever runs.
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}\\p{Pc}\\p{Pd}'\u2019\u02BC]";
const NUMERIC_JOIN = '[.,:/]';

// Trailing possessive-clitic exception: a candidate may end immediately
// before 's / 's when that apostrophe sequence is a closed, complete
// English possessive suffix followed by a genuine outer boundary -- not a
// general apostrophe relaxation. The LEADING boundary is unchanged and
// stays fully strict (apostrophe remains token-internal there), which is
// what continues to block "Connor" from grounding inside "O'Connor" --
// that check never consults this exception, since it only inspects what
// follows a match, never what precedes it. See design review 2026-08-15
// (possessive-apostrophe revision) for the full adversarial matrix.
function boundaryWrap(pattern: string): string {
  const trailingBoundary =
    `(?:(?!${WORD_CHAR})` +
    `|(?=['\\u2019\\u02BC]s?(?!${WORD_CHAR}))` +
    `|(?=s(?!${WORD_CHAR})))`;
  return `(?<!${WORD_CHAR}|\\d${NUMERIC_JOIN})(?:${pattern})${trailingBoundary}(?!${NUMERIC_JOIN}\\d)`;
}

function checkUnicodeBoundarySupport(): boolean {
  try {
    // Exercises every construct findStandardSpan's regexes below actually
    // use: \p{L}, \p{M}, \p{N}, \p{Pc}, \p{Pd}, apostrophe literals,
    // negative lookbehind, negative lookahead, and the u flag together --
    // via the real boundaryWrap function, not a hand-simplified stand-in.
    const probe = new RegExp(boundaryWrap('a'), 'iu');
    return probe.test('a') && !probe.test('ab');
  } catch {
    return false;
  }
}
export const UNICODE_BOUNDARY_SUPPORTED = checkUnicodeBoundarySupport();

/** Standard verbatim span: whitespace-flexible word join; raw span wins (W3d). */
export function findStandardSpan(rawUtterance: string, value: string): string | null {
  if (!UNICODE_BOUNDARY_SUPPORTED) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean).map(escapeRegExp);
  const re = new RegExp(boundaryWrap(parts.join('\\s+')), 'iu');
  const hit = rawUtterance.match(re);
  if (hit) return hit[0];
  const collapsed = trimmed.replace(/\s+/g, '');
  if (collapsed.length === 0) return null;
  const soft = new RegExp(boundaryWrap(collapsed.split('').map(escapeRegExp).join('\\s*')), 'iu');
  const softHit = rawUtterance.match(soft);
  return softHit ? softHit[0] : null;
}

function findPhoneSpan(rawUtterance: string, value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  const re = new RegExp(digits.split('').map(escapeRegExp).join('[\\s\\-().+]*'), 'i');
  const hit = rawUtterance.match(re);
  return hit ? hit[0] : null;
}

export function verifyVerbatim(
  rec: IntentRecord, rawUtterance: string,
): IntentRecord | null {
  const out: Record<string, unknown> = { ...rec };

  if ('items' in out && Array.isArray(out.items)) {
    const grounded: string[] = [];
    for (const it of out.items as unknown[]) {
      if (typeof it !== 'string') continue;
      if (!it.trim()) continue;
      const span = findStandardSpan(rawUtterance, it);
      if (!span) return null;
      grounded.push(span);
    }
    out.items = grounded;
  }

  // W3d: raw_phrase remains the full original utterance, unconditionally.
  if ('raw' in out) out.raw = rawUtterance;

  for (const [key, val] of Object.entries(out)) {
    if (ROUTING_FIELDS.has(key)) {
      // ROUTING_FIELD_GROUNDING_DESIGN_SPEC.md D1/D2/D3 (amended):
      // relation/category/insType are evidence-gated here, not skipped.
      // type and listName remain skip-only (type grounded transitively via
      // required slots per D3; listName out of scope per C5). specialty is
      // not in ROUTING_FIELDS at all — falls through to the standard
      // substring gate below, unchanged (D7 superseded).
      if (
        IN_SCOPE_FIELDS.includes(key as RoutingFieldName) &&
        typeof val === 'string' &&
        val.trim()
      ) {
        const forms = getSurfaceForms(key as RoutingFieldName, val);
        let evidenced = false;
        for (const form of forms) {
          if (findStandardSpan(rawUtterance, form)) {
            evidenced = true;
            break;
          }
        }
        if (!evidenced) return null;
      }
      continue;
    }
    if (key === 'items') continue;
    if (key === 'raw') continue; // W3d: grounded above, never model-authored.
    if (typeof val !== 'string') continue;
    if (!val.trim()) continue;
    if (key === 'phone') {
      const span = findPhoneSpan(rawUtterance, val);
      if (!span) return null;
      out[key] = span;
      continue;
    }
    const span = findStandardSpan(rawUtterance, val);
    if (!span) return null;
    out[key] = span;
  }

  return out as unknown as IntentRecord;
}

function passesRoutingVocab(rec: IntentRecord, vocab: ClassifierVocab): boolean {
  const r = rec as Record<string, unknown>;
  if (typeof r.listName === 'string' && r.listName.trim()) {
    const ln = r.listName.trim().toLowerCase();
    const allowed = new Set([
      ...vocab.knownLists.map(l => l.toLowerCase()),
      'grocery',
      'todo',
    ]);
    if (!allowed.has(ln)) return false;
  }
  if (typeof r.category === 'string' && r.category.trim()) {
    if (!vocab.categories.has(r.category.trim().toLowerCase())) return false;
  }
  if (typeof r.insType === 'string' && r.insType.trim()) {
    if (!vocab.insTypes.has(r.insType.trim().toLowerCase())) return false;
  }
  if (typeof r.relation === 'string' && r.relation.trim()) {
    if (!vocab.relations.has(r.relation.trim().toLowerCase())) return false;
  }
  return true;
}

export function parseClassifierOutput(
  rawText: string, rawUtterance: string, vocab: ClassifierVocab,
): IntentRecord[] {
  const arrStr = extractJsonArray(rawText);
  if (!arrStr) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrStr);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const objects = parsed.filter(
    (el): el is Record<string, unknown> => !!el && typeof el === 'object' && !Array.isArray(el),
  );
  // W2c — first 4 elements kept, before validation
  const capped = objects.slice(0, 4);
  const survivors: IntentRecord[] = [];
  for (const el of capped) {
    try {
      const rec = el as unknown as IntentRecord;
      if (!rec.type || rec.type === 'pass') continue;
      if (!KNOWN_TYPES.has(rec.type)) continue;
      if (!isCaptureComplete(rec)) continue;
      if (!passesFamilyNameSlotLegality(rec, vocab)) continue;
      if (!passesRoutingVocab(rec, vocab)) continue;
      const verified = verifyVerbatim(rec, rawUtterance);
      if (!verified) continue;
      survivors.push(verified);
    } catch {
      continue;   // malformed element — drop it, siblings unaffected
    }
  }
  return survivors;
}

// Names that are placeholders, pronouns, or STT noise — not real captures.
// Mirrors the name.length>=2 floor in householdCapture.ts (one rule, two gates).
const PLACEHOLDER_NAMES = new Set([
  'unknown', 'unnamed', 'none', 'n/a', 'someone', 'somebody',
  'that', 'this', 'it', 'he', 'she', 'they', 'him', 'her', 'them',
]);

function isRealName(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length >= 2 && !PLACEHOLDER_NAMES.has(t.toLowerCase());
}

/** family_capture.name must not be a relationship token (parity with familyCapture.ts). */
function passesFamilyNameSlotLegality(rec: IntentRecord, vocab: ClassifierVocab): boolean {
  if (rec.type !== 'family_capture') return true;
  const name = rec.name?.trim().toLowerCase();
  if (!name) return false;
  return !vocab.relations.has(name);
}

// Guard: a capture is only complete when all required slots have real values.
// Incomplete proposals return null → caller treats as pass → asks instead of inventing.
function isCaptureComplete(rec: IntentRecord): boolean {
  switch (rec.type) {
    case 'service_capture': {
      const hasCategory = !!rec.category?.trim();
      const hasPhone = !!rec.phone?.trim();
      if (isRealName(rec.name) && hasCategory) return true;
      // Partial but actionable — ChatScreen asks for missing name; don't drop to backend.
      if (hasCategory || hasPhone) return true;
      return false;
    }
    case 'family_capture':    return isRealName(rec.name) && !!rec.relation?.trim();
    case 'medical_capture':   return !!rec.drug?.trim();
    case 'medical_visit':     return !!(rec.doctor_name?.trim() || rec.specialty?.trim());
    case 'list_add':          return Array.isArray(rec.items) && rec.items.some(i => !!i?.trim());
    case 'insurance_capture': return !!rec.carrier?.trim() && !!rec.insType?.trim();
    case 'todo_add':          return !!rec.body?.trim();
    case 'todo_complete':     return !!rec.raw?.trim();
    case 'phone_capture':
      return !!(rec.name?.trim() && rec.phone?.trim());
    case 'address_capture':
      return !!(rec.name?.trim() && rec.address?.trim());
    case 'emergency_contact':
      return !!(rec.name?.trim());
    case 'diagnosis_capture':
      return !!rec.condition?.trim();
    default:                  return true;
  }
}

// ─── Layer 1 — Classifier ─────────────────────────────────────────────────────

/** TEMP — device classifier raw JSON diagnostic (logging only). */
export const CLASSIFIER_RAW_LOG_MAX = 512;

export function truncateClassifierRawForLog(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  if (trimmed.length <= CLASSIFIER_RAW_LOG_MAX) return trimmed;
  return `${trimmed.slice(0, CLASSIFIER_RAW_LOG_MAX)}…`;
}

function logClassifierRawDiagnostic(raw: string | undefined, isWarmup: boolean): void {
  if (isWarmup) return;
  console.log('[classifierRaw]', JSON.stringify({
    rawJson: raw ? truncateClassifierRawForLog(raw) : null,
  }));
}

/** TEMP — llama.rn completion surface diagnostic (logging only). */
export type ClassifierCompletionSurfaceLog = {
  tokens_predicted: number | null;
  stopped_word: boolean | null;
  stopping_word: string | null;
  text: string | null;
  content: string | null;
  accumulated_text: string | null;
};

export function buildClassifierCompletionSurfaceLogPayload(
  result: unknown,
): ClassifierCompletionSurfaceLog {
  const r = result as {
    tokens_predicted?: number;
    stopped_word?: boolean;
    stopping_word?: string;
    text?: string;
    content?: string;
    accumulated_text?: string;
  } | null | undefined;
  if (!r) {
    return {
      tokens_predicted: null,
      stopped_word: null,
      stopping_word: null,
      text: null,
      content: null,
      accumulated_text: null,
    };
  }
  const trunc = (v: string | undefined): string | null => {
    if (v == null) return null;
    return truncateClassifierRawForLog(v);
  };
  return {
    tokens_predicted: typeof r.tokens_predicted === 'number' ? r.tokens_predicted : null,
    stopped_word: typeof r.stopped_word === 'boolean' ? r.stopped_word : null,
    stopping_word: typeof r.stopping_word === 'string' ? r.stopping_word : null,
    text: trunc(r.text),
    content: trunc(r.content),
    accumulated_text: trunc(r.accumulated_text),
  };
}

function logClassifierCompletionSurfaceDiagnostic(result: unknown, isWarmup: boolean): void {
  if (isWarmup) return;
  console.log(
    '[classifierCompletionSurface]',
    JSON.stringify(buildClassifierCompletionSurfaceLogPayload(result)),
  );
}

export async function classifyWithLLM(
  userText: string,
  ctx: LlamaContext | null,
  hints: { contacts: string[]; lists: string[]; name?: string },
  opts?: {
    timeoutMs?: number | null;
    modelIdentity?: CanonicalSessionModelIdentity | null;
    /** Fired after successful warmup completion, still under classifier hold,
     *  before nested canonical save. Ready must not wait on snapshot I/O. */
    onWarmupSucceeded?: () => void;
  },
): Promise<ClassifyOutcome> {
  const turnId = getActiveTurnId();
  if (!ctx) {
    latLog('classifyWithLLM skipped', { turnId, reason: 'no-ctx' });
    return { status: 'not_ready', reason: 'no-ctx' };
  }
  const trimmed = userText.trim();
  if (!trimmed) return { status: 'ok', intents: [], readIntents: [], readLabeled: false };

  const gate = await withLlamaContextExclusive('classifier', 'try', async () => {
    const classifyT0 = latMono();
    const isWarmup = trimmed === 'warmup ping';
    const consumer: CtxCompletionConsumer = isWarmup ? 'warmup' : 'classifier';
    const prevMeta = getPrevCtxCompletionMeta();
    latLog('classifyWithLLM START', {
      turnId,
      warmup: isWarmup,
      ...prevMeta,
    });

    // After ephemeral clobbered the shared context, restore the canonical
    // warmup session before this real classify. Nested under this hold —
    // loadSession must never acquire the gate independently.
    // Failure falls through to current full-prefill behavior.
    if (!isWarmup && prevMeta.prevConsumer === 'ephemeral' && opts?.modelIdentity) {
      await maybeLoadCanonicalClassifierSessionBeforeClassify(ctx, opts.modelIdentity);
    }

    const prompt = `You are Herald's on-device intent classifier.
Respond with a JSON ARRAY of 1-4 intent objects: [{...}]. Always an array,
even for a single intent. Output the array on ONE LINE. No prose. No
markdown. No explanation.

INTENT SCHEMAS with EXAMPLES:

LIST ADD — ALWAYS split items into separate array entries, never one string:
{"type":"list_add","items":["apples","oranges","milk"],"listName":"grocery"}
"I need apples oranges and milk" → {"type":"list_add","items":["apples","oranges","milk"],"listName":"grocery"}
"add pay bills and call mom to my to-do list" → {"type":"list_add","items":["pay bills","call mom"],"listName":"todo"}

INSURANCE CAPTURE — replacing, updating, or stating insurance carrier:
{"type":"insurance_capture","insType":"car","carrier":"Allstate"}
"my car insurance is Allstate" → {"type":"insurance_capture","insType":"car","carrier":"Allstate"}
"remove Allstate and replace with Progressive" → {"type":"insurance_capture","insType":"auto","carrier":"Progressive"}

MEDICAL CAPTURE — medications only, never diagnoses:
{"type":"medical_capture","drug":"Lisinopril","dosage":"10mg","frequency":"daily","raw":"I take Lisinopril 10mg daily"}
"I'm on metformin" → {"type":"medical_capture","drug":"metformin","raw":"I'm on metformin"}

MEDICAL VISIT — doctor visits and appointments (never diagnoses, never medications):
{"type":"medical_visit","doctor_name":"Dr. Reyes","raw":"I saw Dr. Reyes today"}
"I saw my cardiologist" → {"type":"medical_visit","specialty":"cardiologist","raw":"I saw my cardiologist"}

SERVICE CAPTURE — plumbers, electricians, mechanics, contractors:
{"type":"service_capture","category":"plumber","name":"Joe","phone":"555-0100"}
"my plumber is Joe his number is 555-0100" → {"type":"service_capture","category":"plumber","name":"Joe","phone":"555-0100"}
"my plumber number is 555-0104" → {"type":"service_capture","category":"plumber","name":"","phone":"555-0104"}

FAMILY CAPTURE — relationships and family members:
{"type":"family_capture","relation":"father-in-law","name":"David","location":"Little Elm Texas"}
"my son lives in New York City his name is Michael" → {"type":"family_capture","relation":"son","name":"Michael","location":"New York City"}

SAME-RELATION FAMILY CAPTURE — split into separate objects, one per person,
when multiple people share one stated relation:
"I have two sons, one named Grant and one named Hunter" →
[{"type":"family_capture","relation":"son","name":"Grant"},{"type":"family_capture","relation":"son","name":"Hunter"}]

TODO ADD:
{"type":"todo_add","body":"call the dentist"}
"remind me to call the dentist" → {"type":"todo_add","body":"call the dentist"}

PASS — use when live data needed, unclear, or none of the above:
{"type":"pass"}

HOUSEHOLD READ — personal-memory QUESTIONS only (never statements/captures):
{"type":"read","domain":"HOUSEHOLD","entity_type":"legal_document","entity":"will","requested_information":"EXISTENCE","raw_phrase":"Do I have a will?","confidence":"high"}
"Do I have a will?" → {"type":"read","domain":"HOUSEHOLD","entity_type":"legal_document","entity":"will","requested_information":"EXISTENCE","raw_phrase":"Do I have a will?","confidence":"high"}
"Where is my will?" → {"type":"read","domain":"HOUSEHOLD","entity_type":"legal_document","entity":"will","requested_information":"LOCATION","raw_phrase":"Where is my will?","confidence":"high"}
"Who do I call for plumbing?" → {"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumbing","requested_information":"IDENTITY","raw_phrase":"Who do I call for plumbing?","confidence":"high"}
"My car insurance is Allstate" → {"type":"insurance_capture","insType":"car","carrier":"Allstate"} NOT read — statements are capture, not read
entity_type must be one of: service_provider, insurance, legal_document
requested_information must be one of: EXISTENCE, IDENTITY, LOCATION, CONTACT, STATUS, ENUMERATION
domain must be HOUSEHOLD for household questions
entity: copy an EXACT contiguous word/phrase from the User line below — never synonyms, never stored categories (plumber/HVAC/will-type labels), never example wording
raw_phrase: must equal the User line exactly — never paraphrase or rewrite the question
confidence: high when clear, low when ambiguous

COMPOUND UTTERANCES — one sentence can carry MORE THAN ONE intent. Emit one
object per intent, in the order spoken:
"I'm taking lisinopril 5mg and I need apples" → [{"type":"medical_capture","drug":"lisinopril","dosage":"5mg","raw":"I'm taking lisinopril 5mg and I need apples"},{"type":"list_add","items":["apples"],"listName":"grocery"}]
"my plumber is Joe and remind me to call the dentist" → [{"type":"service_capture","category":"plumber","name":"Joe"},{"type":"todo_add","body":"call the dentist"}]
"I saw Dr. Reyes today and I need milk and eggs" → [{"type":"medical_visit","doctor_name":"Dr. Reyes","raw":"I saw Dr. Reyes today and I need milk and eggs"},{"type":"list_add","items":["milk","eggs"],"listName":"grocery"}]
A single intent is still an array: "I need apples" → [{"type":"list_add","items":["apples"],"listName":"grocery"}]

CRITICAL RULES:
- ALWAYS respond with an array, on one line. Maximum 4 objects. Never more.
- ALWAYS split list items into array — "apples oranges milk" = ["apples","oranges","milk"], NEVER one string
- Drug names and dosages: copy VERBATIM from speech, never guess or correct spelling
- A visit specialty (cardiologist, dentist, doctor) is NEVER a doctor_name — put it in the specialty field, never invent a "Dr." name
- "remove X replace with Y" for insurance = insurance_capture with new carrier Y
- If user says "add X to my list" or "put X on my list" = ALWAYS list_add, never service_capture or todo_add — even if X sounds like a provider (dentist, plumber, doctor)
- todo_add only when no list name mentioned: "remind me to call dentist", "add pay bills to my to-do"
- Known contacts: ${hints.contacts.slice(0, 15).join(', ') || 'none'}
- Known lists: ${hints.lists.join(', ') || 'grocery, todo'}
- User name: ${hints.name ?? 'unknown'}
- When genuinely unclear → [{"type":"pass"}]

User: "${trimmed.replace(/"/g, '\\"')}"`;

    const __t0 = Date.now();
    let classifyOutcome: 'ok' | 'empty' | 'error' | 'failed' = 'ok';
    let completionSeq: number | null = null;
    let completionEnded = false;
    try {
      completionSeq = beginCtxCompletion(consumer);
      const completionT0 = latMono();
      const result = await ctx.completion({
        messages: [{ role: 'user', content: prompt }],
        n_predict: 256,
        temperature: 0,
        top_k: 1,
        seed: 0,
        stop: ['\n\n', '<|end|>', '<|eot_id|>'],
        ...(isWarmup ? { response_format: CLASSIFIER_RESPONSE_FORMAT } : {}),
      });
      endCtxCompletion(completionSeq, consumer, latMono() - completionT0, result);
      completionEnded = true;
      logClassifierCompletionSurfaceDiagnostic(result, isWarmup);

      // Canonical warmup → snapshot must share this exclusive hold with no
      // intervening release. Ready is signaled before optional save I/O.
      if (isWarmup) {
        opts?.onWarmupSucceeded?.();
        if (opts?.modelIdentity) {
          await saveCanonicalClassifierSessionWhileHoldingExclusive(ctx, opts.modelIdentity);
        }
      }

      const raw = result?.text?.trim();
      console.log('[classifyWithLLM]', JSON.stringify({ ms: Date.now() - __t0, rawLen: raw?.length ?? 0 }));
      if (!raw) {
        classifyOutcome = 'empty';
        logClassifierRawDiagnostic(undefined, isWarmup);
        return { status: 'ok' as const, intents: [] as IntentRecord[], readIntents: [], readLabeled: false };
      }
      logClassifierRawDiagnostic(raw, isWarmup);
      const vocab = buildClassifierVocab(hints.lists);
      const { meta: readMeta, diagnostic: readDiag } = parseReadIntentsFromClassifierWithDiagnostic(raw, trimmed);
      if (readDiag.readLabeled) {
        console.log('[readIntentParse]', JSON.stringify({
          rawJson: readDiag.rawJson,
          readLabeled: readDiag.readLabeled,
          parsedCount: readDiag.parsedCount,
          dropped: readDiag.dropped,
        }));
      }
      return {
        status: 'ok' as const,
        intents: parseClassifierOutput(raw, trimmed, vocab),
        readIntents: readMeta.readIntents,
        readLabeled: readMeta.readLabeled,
      };
    } catch (e) {
      if (completionSeq != null && !completionEnded) {
        endCtxCompletion(completionSeq, consumer, Date.now() - __t0, undefined);
      }
      classifyOutcome = 'failed';
      console.log('[classifyWithLLM] failed', JSON.stringify({ ms: Date.now() - __t0, error: String(e) }));
      if (isWarmup) {
        return { status: 'failed' as const, reason: 'completion_error' as const };
      }
      // Real classify: preserve prior degrade-to-empty behavior for routing.
      classifyOutcome = 'error';
      return { status: 'ok' as const, intents: [] as IntentRecord[], readIntents: [], readLabeled: false };
    } finally {
      latLog('classifyWithLLM END', {
        turnId,
        durationMs: Math.round((latMono() - classifyT0) * 100) / 100,
        outcome: classifyOutcome,
        warmup: isWarmup,
      });
    }
  });

  if (!gate.ok) {
    latLog('classifyWithLLM skipped', { turnId, reason: 'in-flight' });
    console.log('[classifyWithLLM] skipped', JSON.stringify({ reason: 'in-flight' }));
    return { status: 'not_ready', reason: 'in-flight' };
  }
  return gate.value;
}

/** Warmup must succeed (completion ran) before llmStatus becomes ready.
 *  Canonical save nests under the same exclusive hold; onWarmupSucceeded fires
 *  after completion and before save so readiness need not wait on snapshot I/O. */
export async function warmupClassifier(
  ctx: LlamaContext | null,
  identity?: CanonicalSessionModelIdentity | null,
  hooks?: { onWarmupSucceeded?: () => void },
): Promise<void> {
  const __t0 = Date.now();
  if (!ctx) {
    throw new Error('warmupClassifier: no-ctx');
  }
  const out = await classifyWithLLM('warmup ping', ctx, { contacts: [], lists: [] }, {
    timeoutMs: null,
    modelIdentity: identity ?? null,
    onWarmupSucceeded: hooks?.onWarmupSucceeded,
  });
  console.log('[warmupClassifier] done', JSON.stringify({ ms: Date.now() - __t0, status: out.status }));
  if (out.status === 'not_ready') {
    throw new Error(`warmupClassifier: not_ready:${out.reason}`);
  }
  if (out.status === 'failed') {
    throw new Error(`warmupClassifier: ${out.reason}`);
  }
}
