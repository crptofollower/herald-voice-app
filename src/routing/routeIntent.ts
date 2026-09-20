// src/routing/routeIntent.ts
// Single routing authority — pure (text, deps) → one RouteDecision.
// No dispatch, speak, React state, or device imports at module load.

import type { IntentRecord, ClassifyOutcome } from '../hooks/llmLayers';
import type { TierDecision, LocalContext } from './tierRouter';
import { writeServiceProvider, detectServiceCapture, detectPhoneCapture, detectInsuranceCapture, captureHouseholdInsurance, normalizeCarrier } from '../utils/householdCapture';
import { detectDiagnosisCapture, detectDoctorIntroCapture, detectMedicalEvent, isReadShapedUtterance, hasMedicationDomainEvidence, extractDrugName } from '../utils/detectMedicalEvent';
import type { LlamaContext } from 'llama.rn';
import { MEDICATION_SEMANTIC_INTERPRETATION_ENABLED, CAPABILITY_READ_ROUTER_ENABLED, GROCERY_SEMANTIC_DECOMPOSITION_ENABLED, SEMANTIC_CAPABILITY_DISPATCH_ENABLED, NATURAL_MULTI_FACT_INTERPRETATION_ENABLED } from '../constants/features';
import { tryNaturalMultiFactHold, type MultiFactProposalGenerationResult } from './naturalMultiFactInterpretation';
import { generateMedicationSemanticProposal, admitMedicationSemanticProposal, medicationSemanticProposalFromDispatchWrite } from './medicationSemanticInterpretation';
import {
  generateGrocerySemanticProposal,
  admitGrocerySemanticP2,
  tryP1GrocerySemanticItems,
  grocerySemanticProposalFromDispatchWrite,
} from './grocerySemanticDecomposition';
import {
  generateTodoSemanticProposal,
  admitTodoSemanticP2,
  todoSemanticProposalFromDispatchWrite,
} from './todoSemanticCapture';
import { generateCapabilityProposal, admitCapabilityProposal, WIRED_READ_CAPABILITY, CAPABILITY_RISK_CLASS, type CapabilityId, type CapabilityProposal, logSemanticDispatchDiag, type SemanticDispatchDiag } from './capabilityRouting';
import { evaluateSemanticDispatchEligibility } from './semanticDispatchEligibility';
import { detectFamilyCapture } from '../utils/familyCapture';
import { getDB } from '../db/schema';
import { capturePerson } from '../db/capturePerson';
import { findContactByName, setEmergencyContact, getEmergencyContact, retireRelationshipHolder, RELATIONSHIP_WORDS, resolvePersonIdentity, contactHasCapability, resolvePersonCapability, attachPhoneToContactById } from '../db/contactsDB';
import { normalizePersonTarget, liftRelationshipName } from '../utils/personReference';
import { osNameQuery, refineOsNameQuery, osNameFullyCovered } from '../utils/osContactDestination';
import { getActiveTurnId, log as latLog, logSemanticDispatchEligibility, logSemanticMedicationSerialSkip, mono as latMono } from '../utils/latencyInstrument';
import { normalizePhone } from '../utils/phone';
import { buildPhoneConfirmPending, formatPhoneForSpeech } from '../utils/phoneConfirm';
import { matchCandidateToken } from './conversationSession';
import {
  advanceFiniteCandidateRecovery,
  CAPTURE_SECOND_MISS,
  holdUnresolvedRecovery,
  RECOVERY_BUDGET,
  type CallTextTask,
} from './callTextReadiness';
import { realizeGroceryAddAct } from '../conversation/groceryAddRealization';
import { isPersonalMemoryRecallQuestion } from './personalMemoryRecall';
import { isHeraldSelfReferentConversationalShape } from '../utils/ephemeralSelfReferent';
import { shouldRefuseLlmCaptureProposal } from './speechActAuthority';
import type { ReadIntentMeta } from './readIntent';
import {
  extractAmbiguousAcquisitionObject,
  normalizeGroceryListItems,
  parseOperationalDomainResolution,
  extractNarrativeOperationalCandidates,
} from './operationalListContinuity';
import { extractNarrativeTodoAdd, splitNarrativeSentences } from '../utils/instructionSignals';
import { utteranceHasThirdPartyFiniteAction } from './directAddress';

type ActionIntent = NonNullable<TierDecision['actionIntent']>;

export type RouteDecision =
  | { kind: 'device_read'; tier: 1; response: string; isMedical?: boolean; reason: string; presentedMedicationIds?: string[]; presentedGroceryIds?: string[]; presentedTodoIds?: string[]; presentedCalendarEventIds?: string[] }
  | { kind: 'device_action'; tier: 1; actionIntent: ActionIntent; reason: string }
  | { kind: 'capture'; intents: IntentRecord[]; source: 'deterministic' | 'llm' | 'deterministic_recovery'; reason: string }
  | { kind: 'interpretation_hold'; reason: 'natural_multi_fact_v1'; episodeId: string; candidates: import('./naturalMultiFactInterpretation').AdmittedMultiFactCandidate[] }
  | { kind: 'phone_repair_needed'; pending: Extract<CommitResult, { status: 'pending' }>; reason: string }
  | { kind: 'medical_read_pending'; pending: Extract<CommitResult, { status: 'pending' }>; reason: string }
  | { kind: 'not_ready'; reason: string }
  | { kind: 'memory_probe'; tier: 2; context: LocalContext; reason: string }
  | { kind: 'backend'; tier: 3; reason: string; llmAlreadyClassified?: boolean; readMeta?: ReadIntentMeta }
  | { kind: 'needs_clarification'; guess?: string; reason: string; readMeta?: ReadIntentMeta }

// ─── Routing authority scaffolding (Commit 1) ────────────────────────────────
// CommitResult: the only gate for ACK strings. A string is never spoken for a
// write that was not verified. Added here; wired to domains one commit at a time.

// Semantic Focus Contract V1 — Slice 3. Domain-produced semantic IDENTITY
// only (what this result is about) — NO authority/tier field. Per the CTO's
// ARCHITECTURAL AMENDMENT (AUTHORITY HAS ONE OWNER), authority is assigned
// exclusively by conversationTurnLedgerWrite.ts's classifyFocusAuthority(),
// never by the domain that produces this envelope — there is deliberately
// no field here through which a domain could supply, claim, or influence
// one. `sourceIntentType`/a domain taxonomy is deliberately omitted too:
// the enclosing ConversationTurnRecord.intentType (a zero-enumeration raw
// passthrough of IntentRecord['type'], already present since Slice 2)
// already carries sufficient provenance for every focus entry in that
// record — duplicating it here was evaluated and rejected as unjustified.
export type DomainFocusEnvelope = {
  kind: 'person' | 'thing' | 'event' | 'collection' | 'item';
  displayValue: string;
  /** Present ONLY when the domain already possesses a real, stable identity
   *  at this exact call site (e.g. a row id just written/verified, or a
   *  name-is-the-identity convention like Flow C's doctor matching).
   *  NEVER derived by searching text/names after the fact — if a domain
   *  doesn't already have it, it omits this field, never invents one. */
  resolverKey?: string;
  referable: boolean;
  /** Only meaningful when a single writer/read-dispatch call legitimately
   *  produces more than one co-equal entity — not exercised by any Slice 4
   *  domain (medical_capture/list_add/todo_add each produce exactly one). */
  role?: 'primary' | 'secondary';
};

// Active Subject / Reference Continuity V1: a resume closure that only
// GROUNDED a reference (resolved which existing candidate a pronoun/mention
// denoted) rather than committing a domain fact sets this true alongside its
// `focus`. It is the one signal conversationTurnLedgerWrite.ts's
// classifyFocusAuthority() needs to route such a focus to `tier:'conversational'`
// instead of misreading a resolved reference as a fresh authoritative/proposal
// capture. Optional, defaults falsy — every existing writer/resume closure
// omits it and is completely unaffected.
export type CommitResult =
  | { status: 'committed'; ack: string;
      effect?:
        | { kind: 'dial'; phone: string; failAck: string }
        | { kind: 'sms'; phone: string; body?: string; failAck: string }
        | { kind: 'navigate'; address: string; failAck: string };
      /** Optional — see DomainFocusEnvelope above. Absence is legal; a
       *  writer that doesn't populate this has its commit completely
       *  unaffected (Slice 4 proof: focus is carried, never load-bearing). */
      focus?: DomainFocusEnvelope;
      referenceOnly?: boolean }
  | { status: 'pending';   prompt: string; pendingKey: string;
      kind?: 'standard' | 'destructive';
      reaskPrompt?: string;
      releasePrompt?: string;
      budget?: number;
      /** Presentation-only Call/Text capture-repair choices. Not an action path. */
      recoveryChoices?: string[];
      correctable?: import('./conversationSession').CorrectableField;
      resume: (userText: string) => Promise<CommitResult>;
      /** Proposed semantic identity, pre-confirmation — see DomainFocusEnvelope. */
      focus?: DomainFocusEnvelope;
      referenceOnly?: boolean }
  | { status: 'noop';      ack: string; focus?: DomainFocusEnvelope; referenceOnly?: boolean }
  | { status: 'failed';    ack: string; focus?: DomainFocusEnvelope; referenceOnly?: boolean };

export type ResolveContactFn = (n: string) => Promise<{phone:string;name:string;contactId?:string;source:'herald'|'device'}|{phone:null;name:string;source:'device';candidateNames:string[];deviceCandidates:{name:string;phone:string}[]}|null>;

export interface DomainWriter {
  add(intent: IntentRecord, rawPhrase: string, ctx?: { resolveContact?: ResolveContactFn }): Promise<CommitResult>;
  remove(item: string): Promise<CommitResult>;
  clear(): Promise<CommitResult>;
}

export type CaptureContext = { contacts: string[]; lists: string[]; name?: string };
export type DeterministicCapturer = (text: string, ctx: CaptureContext) => IntentRecord[];

// Deterministic capture floor (tier-2). First non-empty result wins — capturers are
// NEVER merged (merging is the parallel-island bug). The on-device LLM (tier-3) is
// reached only when every capturer here returns []. One entry today; phone/list/todo
// follow, one per gated commit.
const DETERMINISTIC_CAPTURERS: DeterministicCapturer[] = [
  (text) => detectDoctorIntroCapture(text),
  (text) => detectInsuranceCapture(text),
  (text) => detectServiceCapture(text),
  (text, ctx) => detectPhoneCapture(text, ctx.contacts),
  (text) => detectDiagnosisCapture(text),
  (text) => detectFamilyCapture(text),
];

export async function resolveContactCallIntent(
  contactName: string,
  raw: string,
  deps: {
    resolveContact?: (n: string) => Promise<{phone:string;name:string;contactId?:string;source:'herald'|'device'}|{phone:null;name:string;source:'device';candidateNames:string[];deviceCandidates:{name:string;phone:string}[]}|null>;
  },
): Promise<IntentRecord> {
  const cleaned = liftRelationshipName(normalizePersonTarget(contactName));

  const identity = resolvePersonIdentity(contactName);
  const osQueryFor = (heraldName?: string) => {
    const fromContact = osNameQuery(contactName, heraldName) || osNameQuery(cleaned, heraldName);
    const fromRaw = osNameQuery(raw, heraldName);
    return refineOsNameQuery(fromContact, fromRaw) || fromContact || fromRaw;
  };

  if (identity.status === 'ambiguous') {
    return {
      type: 'contact_call',
      contact: contactName,
      candidates: identity.candidates.map(c => ({
        name: c.name,
        relationship: c.relationship,
        phone: (c.phone ?? '').trim(),
        importance: c.importance,
      })),
      raw,
    };
  }

  if (identity.status === 'single') {
    const c = identity.contact;

    // OS-multi-always-ask (state doc §9, locked 2026-07-28): resolvePersonCapability
    // is deliberately identity-constrained and must never receive the raw spoken
    // reference. Broad cardinality is checked here first, using the existing
    // raw-utterance resolver — never top-1, never a relationship write from this
    // path. Only phone-bearing device candidates count toward cardinality; a
    // candidate that cannot be dialed is not a candidate.
    if (deps.resolveContact) {
      const deviceQuery = osQueryFor(c.name);
      const broad = deviceQuery ? await deps.resolveContact(deviceQuery) : null;
      if (broad && broad.phone) {
        const heraldPhone = (c.phone ?? '').trim();
        if (!heraldPhone && osNameFullyCovered(deviceQuery, broad.name)) {
          return {
            type: 'contact_call',
            contact: contactName,
            candidates: [{
              name: broad.name,
              relationship: c.relationship,
              phone: broad.phone,
              importance: c.importance,
            }],
            raw,
          };
        }
      }
      const reachableCandidates =
        broad &&
        !broad.phone &&
        'deviceCandidates' in broad
          ? broad.deviceCandidates.filter(dc => !!dc.phone?.trim())
          : [];
      if (reachableCandidates.length > 1) {
        const candidates = reachableCandidates.map(dc => ({ name: dc.name, phone: dc.phone, importance: 5 }));
        return { type: 'contact_call', contact: contactName, candidates, raw };
      }
    }

    const cap = await resolvePersonCapability(c, 'phone');
    if (cap.status === 'available') {
      return {
        type: 'contact_call',
        contact: contactName,
        candidates: [{
          name: c.name,
          relationship: c.relationship,
          phone: cap.value,
          importance: c.importance,
        }],
        raw,
      };
    }
    if (cap.status === 'ambiguous') {
      // OS returned multiple phones for this known person — ask, never top-1.
      return {
        type: 'contact_call',
        contact: contactName,
        candidates: cap.candidates.map(x => ({
          name: x.name,
          phone: (x.phone ?? '').trim(),
          importance: 5,
        })),
        raw,
      };
    }
    // Known person, no phone in Herald or OS — empty-phone candidate → writer known-missing collect.
    return {
      type: 'contact_call',
      contact: contactName,
      candidates: [{
        name: c.name,
        relationship: c.relationship,
        phone: '',
        importance: c.importance,
      }],
      raw,
    };
  }

  // identity.status === 'none' — temporary exception: existing OS fall-through.
  const deviceQuery = osQueryFor() || contactName;
  const device = deviceQuery && deps.resolveContact ? await deps.resolveContact(deviceQuery) : null;
  if (device && device.phone) {
    return { type: 'contact_call', contact: contactName, devicePhone: device.phone, deviceName: device.name, raw };
  }
  if (device && !device.phone && 'deviceCandidates' in device && device.deviceCandidates.length > 0) {
    const candidates = device.deviceCandidates.map(c => ({
      name: c.name,
      phone: c.phone,
      importance: 5,
    }));
    return { type: 'contact_call', contact: contactName, candidates, raw };
  }
  return { type: 'contact_call', contact: contactName, raw };
}

// DD-2 (PENDING_UNIFICATION spec): LLM 'call' intents map to contact_call
// BEFORE any allConverted check — one call-confirm authority (§4a).
export async function mapCallIntents(
  intents: IntentRecord[],
  rawText: string,
  deps: { resolveContact?: Parameters<typeof resolveContactCallIntent>[2]['resolveContact'] },
): Promise<IntentRecord[]> {
  const out: IntentRecord[] = [];
  for (const i of intents) {
    if (i.type === 'call' && typeof (i as any).contact === 'string') {
      const contactName = ((i as any).contact as string)
        .replace(/\s+(?:at|on|using|with|via)\b.*/i, '').trim();
      if (contactName) {
        out.push(await resolveContactCallIntent(contactName, rawText, deps));
        continue;
      }
    }
    out.push(i);
  }
  return out;
}

// Medication bypass closure (CTO review resolution §1, medication-only,
// additive). classifyLLM's own prompt (llmLayers.ts) instructs it to
// self-extract drug/dosage/frequency directly from free text for
// 'medical_capture' — the ONLY gate standing between that model output and
// DOMAIN_WRITERS.medical_capture was shouldRefuseLlmCaptureProposal's D1/D3/
// D4/D5, which test address/narrative shape, never medication-domain
// evidence. This closes that gap at the single site (below) where an
// 'llm'-sourced capture becomes a RouteDecision, by requiring the exact same,
// completely unmodified hasMedicationDomainEvidence the deterministic floor
// already uses. Deliberately scoped to 'medical_capture' only — does not
// generalize to any other STATE_CAPTURE_TYPES member, does not modify
// speechActAuthority.ts, does not touch classifyLLM or DOMAIN_WRITERS.
export function llmMedicationCaptureLacksEvidence(text: string, intents: IntentRecord[]): boolean {
  return intents.some((i) => {
    if (i.type !== 'medical_capture') return false;
    const candidate = i.drug?.trim() || extractDrugName(text);
    return !hasMedicationDomainEvidence(text, candidate);
  });
}

/**
 * Derive a bounded contact-name reference from a free-form known-person collect
 * reply. Returns null when no name span is present (fail-closed). Extraction
 * does not prove identity, select an OS contact, authorize a call, or write memory.
 */
function extractCollectContactNameReference(reply: string): string | null {
  const trimmed = reply.trim().replace(/[.!?]+$/, '').trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  const FRAMING_ONLY = [
    /^i don'?t know$/,
    /^i'?m not sure$/,
    /^maybe$/,
    /^i can'?t remember$/,
    /^it'?s in my contacts$/,
    /^it'?s in my phone contacts$/,
    /^look in my contacts$/,
    /^look in my phone contacts$/,
    /^never\s*mind$/,
    /^nevermind$/,
  ];
  if (FRAMING_ONLY.some(re => re.test(lower))) return null;

  const normalizeNameSpan = (span: string): string | null => {
    const s = span.trim().replace(/[.!?]+$/, '').trim();
    if (!s || s.length < 2 || s.length > 80 || !/[A-Za-z]/.test(s)) return null;
    const spanLower = s.toLowerCase();
    if (/^(?:i don'?t know|i'?m not sure|maybe|i can'?t remember|never\s*mind|nevermind|cancel|stop)$/i.test(spanLower)) {
      return null;
    }
    const CONVERSATION_ONLY = /^(?:in|my|phone|contacts|not|sure|don'?t|know|maybe|it'?s|i'?m|look|for|the|a|an)$/i;
    const tokens = s.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.every(tok => CONVERSATION_ONLY.test(tok))) return null;
    return s;
  };

  const lookFor = trimmed.match(/^look in my (?:phone )?contacts for\s+(.+)$/i);
  if (lookFor) return normalizeNameSpan(lookFor[1]);

  const afterContacts = trimmed.match(/(?:phone )?contacts(?:\s*(?:[—\-:,]\s*|\s+for\s+)|\s+)(.+)$/i);
  if (afterContacts) return normalizeNameSpan(afterContacts[1]);

  const itsName = trimmed.match(/^it'?s\s+(?!in\s+my\s+(?:phone\s+)?contacts\b)(.+)$/i);
  if (itsName) return normalizeNameSpan(itsName[1]);

  return normalizeNameSpan(trimmed);
}

// Registry: empty now. One domain added per conversion commit.
export const DOMAIN_WRITERS: Partial<Record<string, DomainWriter>> = {
  service_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'service_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { category, name, phone } = intent;
      const PLACEHOLDER_NAMES = new Set(['unknown','unnamed','none','n/a','someone',
        'somebody','that','this','it','he','she','they','him','her','them',
        'guy','gal','lady','person','man','woman','dude','fellow','girl','folks']);
      const isRealName = (v: string): boolean => {
        if (typeof v !== 'string') return false;
        const t = v.trim();
        if (t.length < 2) return false;
        if (PLACEHOLDER_NAMES.has(t.toLowerCase())) return false;
        if (/^\d[\d\s\-\(\)\+\.]*$/.test(t)) return false; // digit-only
        const first = t.split(/\s+/)[0].toLowerCase();
        const STOP_WORDS = new Set([
          'what','whats',"what's",'who','when','where','why','how',
          'my','our','his','her','their','your','its',
          'the','a','an','this','that','these','those',
          'never','no','nope','nah','cancel','stop','ok','okay',
          // Imperative action verbs — never a valid service-provider name.
          // Last-line-of-defence: blocks "Delete"/"Remove" leaking in as names
          // if the LLM classifies a removal utterance as service_capture.
          'delete','remove','clear','erase','update','change',
        ]);
        if (STOP_WORDS.has(first)) return false;
        return true;
      };
      if (!category?.trim()) {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const writeProvider = (nm: string, ph?: string): CommitResult => {
        const spId = writeServiceProvider(category, nm, ph);
        if (!spId) {
          return { status: 'failed', ack: "Hmm — I couldn't hold onto that just now. Mind telling me once more?" };
        }
        const phoneForAck = ph && /^\d{10}$/.test(ph)
          ? `${ph.slice(0, 3)}-${ph.slice(3, 6)}-${ph.slice(6, 10)}`
          : ph;
        const numberPart = phoneForAck ? ` — you can reach them at ${phoneForAck}` : '';
        return { status: 'committed', ack: composeCaptureAck('service_capture', `${nm} is your ${category}${numberPart}.`) };
      };
      // M1 completion, 2026-08-13: a spoken service-provider phone number is a
      // candidate, not truth — same trust boundary as phone_capture /
      // emergency_contact / phone_repair. No-phone captures are unaffected;
      // they still commit immediately through writeProvider below.
      const commit = (nm: string): CommitResult => {
        if (phone && phone.trim()) {
          const formattedPhone = formatPhoneForSpeech(phone);
          return buildPhoneConfirmPending(
            { name: nm, phone },
            {
              prompt: `Got it — ${nm} is your ${category} at ${formattedPhone}. Is that right?`,
              onConfirm: (c) => writeProvider(c.name, c.phone),
            },
          );
        }
        return writeProvider(nm);
      };

      const extractName = (raw: string): string | null => {
        let t = raw.trim().replace(/[.!?]+$/, '');
        // Strip common lead-ins so "It's Joe" → "Joe", "His name is Joe" → "Joe"
        t = t.replace(/^(it'?s|that'?s|his name is|her name is|the name is|he'?s|she'?s|call (?:him|her)|name'?s|the (?:guy|person) is)\s+/i, '');
        // If what remains looks like a NEW capture command, abort — do not treat
        // "My roofer is 552-03303" as a name when pending electrician.
        if (/^(my|our)\s+\w/i.test(t)) return null;
        const first = t.split(/\s+/)[0];
        if (!first) return null;
        // Reuse the hardened isRealName check on the extracted first word
        if (!isRealName(first)) return null;
        // Must look like a name: starts alpha, only alpha/apostrophe/hyphen,
        // max 2 words (handles "Mary Beth"), not all-caps abbreviation
        if (!/^[A-Za-z][a-zA-Z'\-]+$/.test(first)) return null;
        return first;
      };

      if (!isRealName(name)) {
        const prompt = phone
          ? `Who's your ${category} at ${phone}?`
          : `I didn't catch the name — who's your ${category}?`;
        return {
          status: 'pending', prompt, pendingKey: 'service_capture',
          resume: async (userText: string): Promise<CommitResult> => {
            const nm = extractName(userText);
            if (!nm) return { status: 'noop', ack: '' }; // non-answer → caller re-routes, no write
            return commit(nm);
          },
        };
      }
      return commit(name);
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: `I can't take that off just yet — but I've still got it, and I won't lose it.` };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: `I can't take that off just yet — but I've still got it, and I won't lose it.` };
    },
  },
  list_add: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'list_add') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const rawListName = intent.listName ?? 'grocery';
      const listName = rawListName === 'todo' ? 'todos' : rawListName;
      // Grocery Integrity V1: normalize at the writer convergence point so
      // deterministic- and classifier-produced intents are segmented identically
      // (Oxford comma corrected; any compound element re-split) before commit.
      const itemList = normalizeGroceryListItems(intent.items ?? []);
      if (itemList.length === 0) {
        return { status: 'failed', ack: `What did you want to add to your ${listName} list?` };
      }
      const db = getDB();
      let list = db.getFirstSync<{ id: string }>(`SELECT id FROM lists WHERE name = ?`, [listName]);
      const now = new Date().toISOString();
      // Grocery Integrity V1: acknowledgement derives from commit truth, never
      // from the requested candidate set. Track exactly which items committed.
      const committed: string[] = [];
      // Same transaction pattern as calendarCacheDB: BEGIN IMMEDIATE / COMMIT / ROLLBACK
      // so list creation + item inserts are atomic (no partial multi-item write).
      try {
        db.execSync('BEGIN IMMEDIATE;');
      } catch (beginErr) {
        console.error('[LIST_ADD_BEGIN_FAILED]', beginErr);
        throw beginErr;
      }
      try {
        if (!list) {
          const listId = `list_${Date.now()}`;
          db.runSync(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`, [listId, listName, now]);
          list = { id: listId };
        }
        for (const item of itemList) {
          const exists = db.getFirstSync<{ id: string }>(
            `SELECT li.id FROM list_items li JOIN lists l ON l.id = li.list_id
             WHERE l.name = ? AND lower(li.body) = lower(?) AND li.checked = 0`,
            [listName, item],
          );
          if (!exists) {
            db.runSync(
              `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, 0, ?)`,
              [`item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, list.id, item, now],
            );
            committed.push(item);
          }
        }
        db.execSync('COMMIT;');
      } catch (err) {
        console.error('[LIST_ADD_CATCH]', err);
        db.execSync('ROLLBACK;');
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      if (committed.length === 0) {
        // Zero-commit: every requested item was already present. Truthful about
        // count — a single requested duplicate names itself; multiple rejected
        // duplicates never single one out. Response Realization V1 wording
        // (single-item path only); the multi-item wording is not enrolled.
        return itemList.length === 1
          ? { status: 'noop', ack: realizeGroceryAddAct({ kind: 'already_had_one', item: itemList[0], listName }) }
          : { status: 'noop', ack: `Those were already on your ${listName} list.` };
      }
      // Semantic Focus Contract V1 — Slice 4. list.id is the real list row
      // id — either just SELECTed or just INSERTed and already COMMITted
      // above, never derived after the fact. Collection-level only,
      // deliberately: an "add milk, eggs, and bananas" turn does not
      // produce per-item focus merely because itemList.length > 1 — the
      // list itself is what remains conversationally referable at this
      // boundary; item-level addressability stays with the existing
      // presentation-holder mechanism, unchanged this slice.
      const listFocus = { kind: 'collection' as const, displayValue: `${listName} list`, resolverKey: list.id, referable: true };
      if (committed.length === 1) {
        // Grocery Integrity V1: the ack names the item that ACTUALLY committed
        // (committed[0]), not the first requested candidate — so when leading
        // candidates were duplicates, the ack no longer claims one of them.
        // Response Realization V1 wording/mechanism unchanged; only the input
        // value is now commit-truth.
        return {
          status: 'committed',
          ack: composeCaptureAck('list_add', realizeGroceryAddAct({ kind: 'added_one', item: committed[0], listName })),
          focus: listFocus,
        };
      }
      // Collection-level focus stays ONE entry regardless of how many rows
      // committed (Semantic Focus Contract V1 — Slice 4, unchanged); only the
      // count spoken is now commit-truth.
      return { status: 'committed', ack: composeCaptureAck('list_add', `${committed.length} items are on your ${listName} list now.`), focus: listFocus };
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  todo_add: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'todo_add') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const body = intent.body?.trim();
      if (!body || body.length < 2) {
        return { status: 'failed', ack: "What did you want me to remember to do?" };
      }
      const db = getDB();
      let todoList = db.getFirstSync<{ id: string }>(`SELECT id FROM lists WHERE name = ?`, ['todos']);
      if (!todoList) {
        const listId = `list_todos_${Date.now()}`;
        db.runSync(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`, [listId, 'todos', new Date().toISOString()]);
        todoList = { id: listId };
      }
      const exists = db.getFirstSync<{ id: string }>(
        `SELECT li.id FROM list_items li JOIN lists l ON l.id = li.list_id
         WHERE l.name = 'todos' AND lower(li.body) = lower(?) AND li.checked = 0`,
        [body],
      );
      if (exists) {
        return { status: 'noop', ack: `That's already on your to-do list.` };
      }
      const newItemId = `todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      db.runSync(
        `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, 0, ?)`,
        [newItemId, todoList.id, body, new Date().toISOString()],
      );
      const openCount = db.getFirstSync<{ n: number }>(
        `SELECT COUNT(*) as n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'todos' AND li.checked = 0`,
      )?.n ?? 1;
      const ack = composeCaptureAck('todo_add', openCount === 1
        ? `'${body}' is on your to-do list.`
        : `'${body}' is on your to-do list. You've got ${openCount} open.`);
      // Semantic Focus Contract V1 — Slice 4. newItemId is the exact id
      // just inserted above (same value, reused — not regenerated), the
      // real, stable identity for this item, never derived after the fact.
      return { status: 'committed', ack, focus: { kind: 'item', displayValue: body, resolverKey: newItemId, referable: true } };
    },
    async remove(item: string): Promise<CommitResult> {
      const db = getDB();
      const row = db.getFirstSync<{ id: string; body: string; checked: number }>(
        `SELECT id, body, checked FROM list_items WHERE id = ?;`,
        [item],
      );
      if (!row || row.checked !== 0) {
        return { status: 'noop', ack: "I don't have that on your list anymore." };
      }
      const body = row.body;
      return {
        status: 'pending',
        kind: 'standard',
        prompt: `Just to make sure — you're saying you've completed '${body}'? I can mark that off your list.`,
        pendingKey: 'todo_complete',
        resume: async (userText: string): Promise<CommitResult> => {
          const trimmed = userText.trim();
          const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
          if (CONFIRM_NO_RE.test(trimmed)) {
            return { status: 'noop', ack: `Got it — leaving '${body}' on your list.` };
          }
          if (CONFIRM_YES_RE.test(trimmed)) {
            try {
              const now = new Date().toISOString();
              db.runSync(
                `UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ?;`,
                [now, item],
              );
            } catch {
              return { status: 'failed', ack: "Couldn't update that. Try again." };
            }
            return { status: 'committed', ack: `Done — crossed off '${body}'.` };
          }
          return { status: 'noop', ack: '' };
        },
      };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  todo_complete: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'todo_complete') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { getPresentedOpenListItems, matchTodoCompleteItem } = await import('../db/listRead');
      const items = getPresentedOpenListItems('todos');
      if (items.length === 0) {
        return { status: 'noop', ack: 'Nothing open on your to-do list.' };
      }
      const raw = intent.raw ?? rawPhrase;
      const bestMatch = matchTodoCompleteItem(raw, items);
      if (!bestMatch) {
        return { status: 'noop', ack: "I couldn't match that to anything on your list. Want me to read your to-dos?" };
      }
      return DOMAIN_WRITERS.todo_add!.remove(bestMatch.id);
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  phone_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'phone_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const name = intent.name?.trim();
      const phone = intent.phone?.trim();
      const relationship = intent.relationship?.trim() || undefined;
      if (!name || name.length < 2) {
        return { status: 'failed', ack: "I didn't catch the name — who's number is that?" };
      }
      if (!phone || phone.length < 7) {
        return { status: 'failed', ack: "I didn't catch the number — can you say it again?" };
      }
      // D-phone-confirm, 2026-08-13: read back and hold as a candidate —
      // syntactic validity alone is not sufficient evidence to commit.
      const relPart = relationship ? `, your ${relationship},` : '';
      const formattedPhone = formatPhoneForSpeech(phone);
      return buildPhoneConfirmPending(
        { name, phone, relationship },
        {
          prompt: `Got it — ${name}${relPart} at ${formattedPhone}. Is that right?`,
          onConfirm: (c) => {
            try {
              capturePerson({ name: c.name, phone: c.phone, relationship: c.relationship });
              const saved = findContactByName(c.name);
              if (!saved) {
                return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
              }
              const rp = c.relationship ? `, your ${c.relationship},` : '';
              const fp = formatPhoneForSpeech(c.phone);
              return { status: 'committed', ack: composeCaptureAck('phone_capture', `${c.name}${rp} at ${fp}.`) };
            } catch {
              return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
            }
          },
        },
      );
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  address_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'address_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const name = intent.name?.trim();
      const address = intent.address?.trim();
      if (!name || name.length < 2) {
        return { status: 'failed', ack: "I didn't catch the name — whose address is that?" };
      }
      if (!address || address.length < 5) {
        return { status: 'failed', ack: "I didn't catch the address — can you say it again?" };
      }
      try {
        capturePerson({ name, address });
        const saved = findContactByName(name);
        if (!saved) {
          return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
        }
        return { status: 'committed', ack: composeCaptureAck('address_capture', `I'll remember that for next time you need directions.`) };
      } catch {
        return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
      }
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  family_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'family_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const PLACEHOLDER_NAMES = new Set(['unknown','unnamed','none','n/a','someone',
        'somebody','that','this','it','he','she','they','him','her','them']);
      const isRealName = (v: unknown): v is string => {
        if (typeof v !== 'string') return false;
        const t = v.trim();
        return t.length >= 2 && !PLACEHOLDER_NAMES.has(t.toLowerCase());
      };
      const famName = intent.name?.trim();
      const relation = intent.relation?.trim();
      const location = intent.location?.trim() || undefined;
      if (!relation) {
        return { status: 'failed', ack: "I didn't catch the relationship — who are they to you?" };
      }
      if (!isRealName(famName)) {
        return { status: 'failed', ack: `I didn't catch the name — who is your ${relation}?` };
      }
      const confirmPrompt = location
        ? `${famName}, your ${relation}, in ${location} — that right?`
        : `${famName}, your ${relation} — that right?`;
      return {
        status: 'pending',
        prompt: confirmPrompt,
        pendingKey: 'family_capture',
        resume: async (userText: string): Promise<CommitResult> => {
          const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|affirmative|confirmed|confirm|y)[\s.,!]*$/i;
          const NO = /^(no|nope|nah|wrong|incorrect|that'?s wrong|not right|cancel|nevermind|never mind)[\s.,!]*$/i;
          if (NO.test(userText.trim())) {
            return {
              status: 'pending',
              prompt: `No problem — what's the correct name?`,
              pendingKey: 'family_capture_correction',
              resume: async (correctionText: string): Promise<CommitResult> => {
                const correctedName = correctionText.trim();
                if (!isRealName(correctedName)) {
                  return { status: 'noop', ack: '' };
                }
                try {
                  const { capturePerson } = await import('../db/capturePerson');
                  const { findContactByName } = await import('../db/contactsDB');
                  capturePerson({ name: correctedName, relationship: relation, location });
                  const saved = findContactByName(correctedName);
                  if (!saved) {
                    return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
                  }
                  const ack = composeCaptureAck('family_capture', location
                    ? `I'll remember ${correctedName} is your ${relation} in ${location}.`
                    : `I'll remember ${correctedName} is your ${relation}.`);
                  return { status: 'committed', ack };
                } catch {
                  return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
                }
              },
            };
          }
          if (!YES.test(userText.trim())) {
            return { status: 'noop', ack: '' };
          }
          try {
            const { capturePerson } = await import('../db/capturePerson');
            const { findContactByName } = await import('../db/contactsDB');
            capturePerson({ name: famName, relationship: relation, location });
            const saved = findContactByName(famName);
            if (!saved) {
              return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
            }
            const ack = composeCaptureAck('family_capture', location
              ? `I'll remember ${famName} is your ${relation} in ${location}.`
              : `I'll remember ${famName} is your ${relation}.`);
            return { status: 'committed', ack };
          } catch {
            return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
          }
        },
        correctable: {
          currentValue: famName,
          // Named function expression so buildCorrected can recurse into itself
          // without a TDZ/self-reference error on the outer property binding.
          buildCorrected: function buildCorrected(newValue: string) {
            const correctedPrompt = location
              ? `${newValue}, your ${relation}, in ${location} — that right?`
              : `${newValue}, your ${relation} — that right?`;
            return {
              pendingKey: 'family_capture_correction_confirm',
              prompt: correctedPrompt,
              resume: async (confirmText: string): Promise<CommitResult> => {
                const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
                const t = confirmText.trim();
                if (CONFIRM_NO_RE.test(t)) {
                  return { status: 'noop', ack: "No problem — I won't remember that." };
                }
                if (!CONFIRM_YES_RE.test(t)) {
                  return { status: 'noop', ack: '' };
                }
                try {
                  const { capturePerson } = await import('../db/capturePerson');
                  const { findContactByName } = await import('../db/contactsDB');
                  capturePerson({ name: newValue, relationship: relation, location });
                  const saved = findContactByName(newValue);
                  if (!saved) {
                    return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
                  }
                  const ack = composeCaptureAck('family_capture', location
                    ? `I'll remember ${newValue} is your ${relation} in ${location}.`
                    : `I'll remember ${newValue} is your ${relation}.`);
                  return { status: 'committed', ack };
                } catch {
                  return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
                }
              },
              correctable: {
                currentValue: newValue,
                buildCorrected,
              },
            };
          },
        },
      };
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  emergency_contact: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'emergency_contact') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const name = intent.name?.trim();
      const phone = intent.phone?.trim() || undefined;
      if (!name || name.length < 2) {
        return { status: 'failed', ack: "I didn't catch the name — who's your emergency contact?" };
      }
      const commitEmergency = (n: string, p?: string): CommitResult => {
        try {
          setEmergencyContact(n, p);
          const saved = getEmergencyContact();
          if (!saved) {
            return { status: 'failed', ack: "Something went wrong holding onto that. Try again." };
          }
          const ack = composeCaptureAck('emergency_contact', p
            ? `If you ever need help, I'll reach ${n} at that number.`
            : `${n} is your emergency contact. Tell me their number when you get a chance.`);
          return { status: 'committed', ack };
        } catch {
          return { status: 'failed', ack: "Something went wrong holding onto that. Try again." };
        }
      };
      if (!phone) {
        // No phone spoken — nothing high-entropy to confirm, commit as before.
        return commitEmergency(name);
      }
      // D-phone-confirm: the emergency-contact phone number carries the
      // highest consequence of any phone value in Herald — a wrong-but-
      // valid number dialed during a real emergency. Confirm before
      // persistence, identically to phone_capture.
      return buildPhoneConfirmPending(
        { name, phone },
        {
          prompt: `Got it — ${name} at ${formatPhoneForSpeech(phone)} as your emergency contact. Is that right?`,
          onConfirm: (c) => commitEmergency(c.name, c.phone),
        },
      );
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  medical_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'medical_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const raw = intent.raw ?? rawPhrase;
      const { guessMedicationName } = await import('../db/medicalDB');
      const { extractFrequency } = await import('../utils/detectMedicalEvent');
      const name = intent.drug?.trim() || guessMedicationName(raw);
      const dosage = intent.dosage?.trim() || undefined;
      const frequency = intent.frequency?.trim() || extractFrequency(raw) || undefined;
      if (!name || name.trim().length < 2) {
        return { status: 'failed', ack: 'What medication is that?' };
      }
      // Conversational Presentation Contract V1: confirmation recites only
      // already-authoritative name/dosage/frequency. Comma between drug and
      // dosage; space-only between drug and frequency when dosage is absent.
      const taking =
        dosage && frequency ? `${name}, ${dosage}, ${frequency}`
        : dosage ? `${name}, ${dosage}`
        : frequency ? `${name} ${frequency}`
        : name;
      const confirmPrompt = `You're taking ${taking}. Want me to remember that?`;
      // Semantic Focus Contract V1 — Slice 4. Proposed identity only: no
      // medication row exists yet, so no resolverKey. The glue layer
      // (conversationTurnLedgerWrite.ts) is solely responsible for turning
      // this into tier:'deterministic_unconfirmed'/'llm_proposal' — this
      // function has no say in that classification.
      const proposedFocus = { kind: 'thing' as const, displayValue: name, referable: true };
      return {
        status: 'pending',
        prompt: confirmPrompt,
        pendingKey: 'medical_capture',
        focus: proposedFocus,
        resume: async (userText: string): Promise<CommitResult> => {
          const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|y)\b/i;
          const NO  = /^(no|nope|nah|wrong|not right|cancel|nevermind|never mind)\b/i;
          if (NO.test(userText.trim())) return { status: 'noop', ack: `No problem — I won't add that.` };
          if (!YES.test(userText.trim())) return { status: 'noop', ack: '' };
          try {
            const { confirmMedicationCapture, getActiveMedications } = await import('../db/medicalDB');
            const result = confirmMedicationCapture(name, dosage, raw, frequency);
            const verified = getActiveMedications().some(m => m.id === result.id);
            if (!verified) {
              return { status: 'failed', ack: "I'm having trouble holding onto that — say it once more?" };
            }
            // Semantic Focus Contract V1 — Slice 4. result.id is the real,
            // just-written-and-verified medication row id (verified above
            // via getActiveMedications().some(...)) — the exact
            // "already possesses a real, stable identity at this call
            // site" case DomainFocusEnvelope.resolverKey requires. Never
            // derived by searching name/text after the fact.
            const committedFocus = { kind: 'thing' as const, displayValue: name, resolverKey: result.id, referable: true };
            if (result.action === 'superseded') {
              return { status: 'committed',
                ack: composeCaptureAck('medical_capture', "Got it. I've updated it."),
                focus: committedFocus };
            }
            return { status: 'committed',
              ack: composeCaptureAck('medical_capture', "Got it. I'll remember that."),
              focus: committedFocus };
          } catch {
            return { status: 'failed', ack: "I'm having trouble holding onto that — say it once more?" };
          }
        },
      };
    },
    async remove(item: string): Promise<CommitResult> {
      try {
        const { deactivateMedicationByName } = await import('../db/medicalDB');
        const changes = deactivateMedicationByName(item);
        return changes > 0
          ? { status: 'committed', ack: composeCaptureAck('medical_capture', `I've taken ${item} off your current medications.`) }
          : { status: 'noop', ack: `I don't have ${item} in your current medications.` };
      } catch { return { status: 'failed', ack: "I couldn't do that right now — try again." }; }
    },
    async clear(): Promise<CommitResult> {
      // Destructive class (Spine §4a + S_DISCLOSE §4.5): clear NEVER executes
      // without an explicit anchored YES. Ambiguity releases, never wipes.
      let count = 0;
      try {
        const { getActiveMedications } = await import('../db/medicalDB');
        count = getActiveMedications().length;
      } catch {
        return { status: 'failed', ack: "I couldn't do that right now — try again." };
      }
      if (count === 0) {
        return { status: 'noop', ack: `You don't have any medications saved right now.` };
      }
      return {
        status: 'pending',
        kind: 'destructive',
        prompt: `This will remove all ${count} of your medications. Are you sure?`,
        pendingKey: 'medical_clear',
        resume: async (userText: string): Promise<CommitResult> => {
          const trimmed = userText.trim();
          const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
          if (CONFIRM_NO_RE.test(trimmed)) {
            return { status: 'noop', ack: `Okay — I left your medications as they are.` };
          }
          if (CONFIRM_YES_RE.test(trimmed)) {
            let removed = 0;
            try {
              const { clearAllMedications } = await import('../db/medicalDB');
              removed = clearAllMedications();
            } catch {
              return { status: 'failed', ack: "I couldn't do that right now — try again." };
            }
            return { status: 'committed',
              ack: removed > 0
                ? `Done — cleared ${removed} ${removed === 1 ? 'medication' : 'medications'}. You can start fresh anytime.`
                : `There were no active medications to clear.` };
          }
          return { status: 'noop', ack: '' }; // ambiguous → primitive releases; never executes
        },
      };
    },
  },
  medical_visit: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'medical_visit') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { writeMedicalRecord, attachVisitOutcome } = await import('../db/medicalDB');
      const { extractDoctorName, extractDoctorAttributedOutcome } = await import('../utils/detectMedicalEvent');
      const { parseDatePhrase } = await import('../utils/parseTime');
      const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
      const raw = intent.raw ?? rawPhrase;
      const advice = intent.advice?.trim();
      const visitDate = parseDatePhrase(raw) ?? new Date().toLocaleDateString('en-CA');
      const visitOutcome = extractDoctorAttributedOutcome(raw);

      // Trust repair 2026-08-20 (Continuity audit v2 §3.3): `raw` is the
      // CAPTURE turn's utterance and was device-proven storing a read question
      // ("Who was the last Doctor I saw") as visit detail, which then spoke
      // back through getLastVisit's unhinted path. A question-shaped utterance
      // is never visit provenance — the visit still commits, the bad detail
      // simply is not stored. Verbatim rule is unaffected: nothing is
      // rewritten, only omitted (Spine §3).
      const visitNotes = isReadShapedUtterance(raw)
        ? undefined
        : (advice ? `${raw} — ${advice}` : raw);

      const commitVisit = (doctorName: string): CommitResult => {
        const id = writeMedicalRecord({
          doctor_name: doctorName,
          notes: visitNotes,
          visit_date: visitDate,
        });
        if (visitOutcome) {
          attachVisitOutcome(id, visitOutcome, raw);
        }
        return {
          status: 'committed',
          ack: composeCaptureAck('medical_visit', `I'll remember you saw ${doctorName}.`),
          // Doctors carry no opaque entity id in this schema (see
          // conversationalSubject.ts) — every deterministic doctor reader
          // (getLastVisit, getUpcomingAppointments, getMedicalContacts) keys
          // by normalized name, not the medical_records row id `id` above.
          // resolverKey must be the name itself to stay reread-able.
          focus: { kind: 'person', displayValue: doctorName, resolverKey: doctorName, referable: true },
        };
      };

      const confirmVisit = (doctorName: string): CommitResult => {
        const outcomeBit = visitOutcome ? ` — ${visitOutcome}` : '';
        return {
          status: 'pending',
          prompt: `Want me to remember you saw ${doctorName}${outcomeBit}?`,
          pendingKey: 'medical_visit',
          resume: async (userText: string): Promise<CommitResult> => {
            const trimmed = userText.trim();
            if (CONFIRM_NO_RE.test(trimmed)) {
              return { status: 'noop', ack: `No problem — I won't add that.` };
            }
            if (!CONFIRM_YES_RE.test(trimmed)) return { status: 'noop', ack: '' };
            return commitVisit(doctorName);
          },
        };
      };

      // Heard "Dr. X" is identity evidence, not a write license. Confirmation
      // owns the commit (same CONFIRM_YES/NO authority as other trust-critical
      // medical writes). Nameless visits still ask who, then confirm.
      const heardName = intent.doctor_name?.trim();
      if (heardName) return confirmVisit(heardName);

      // No clean name (specialty-only / nameless) → ask, write NOTHING (Spine §5,
      // Graceful Confusion). Replaces the old writeClarification('', ...) empty-id bug.
      return {
        status: 'pending',
        prompt: 'Got it — who did you see?',
        pendingKey: 'medical_visit',
        resume: async (userText: string): Promise<CommitResult> => {
          // Trust repair 2026-08-20 (Continuity audit v2 §3.3): the former
          // two-token shape-test fallback admitted arbitrary speech as a
          // doctor name — device-proven writing doctor_name:"No stop" from a
          // cancel-shaped reply that CANCEL_RE's anchoring let through. A
          // shape test cannot establish that a token IS a name. Only an
          // explicitly heard "Dr. X" writes here (Spine §3/§5, and the
          // add()-path comment above that already states this rule).
          // Unrecognized replies return the honest noop; ConversationSession's
          // re-ask ladder and budgeted release own the interaction from there.
          const name = extractDoctorName(userText);
          if (!name) return { status: 'noop', ack: '' }; // not a name → ladder re-asks
          return confirmVisit(name);
        },
      };
    },
    async remove(item: string): Promise<CommitResult> {
      // medical_records.removed_at landed in schema v18. A visit-remove path can
      // now soft-delete; left as a deliberate noop until a visit-remove utterance
      // is actually wired. Never a hard delete.
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  medical_visit_upcoming: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'medical_visit_upcoming') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { writeMedicalRecord, passesSubstringGate, getMedicalRecords, findMatchingUpcomingAppointment } = await import('../db/medicalDB');
      const { parseDatePhrase, formatSpokenDate } = await import('../utils/parseTime');
      const { buildCalendarCollectSlot, writeCalendarCore } = await import('./calendarWrite');
      const raw = intent.raw ?? rawPhrase;
      const doctorNameRaw = intent.doctor_name?.trim();
      const doctorName = (doctorNameRaw && passesSubstringGate(doctorNameRaw, raw)) ? doctorNameRaw : undefined;

      const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|that'?s it|exactly|y)\b/i;
      const NO = /^(no|nope|nah|wrong|not right|that'?s wrong|incorrect|cancel|nevermind|never mind)\b/i;

      // Single acknowledgement rule: the medical write is the source of truth
      // and completes (verified) before anything calendar-related is even
      // attempted. Calendar visibility is a best-effort add-on chained onto
      // the same turn's ack — it is never allowed to make the medical
      // commit itself conditional, delayed, or reversible. No time is ever
      // fabricated (Trust First) — if none was given, Herald asks, once,
      // reusing the existing calendar collect-slot machinery verbatim.
      const commitUpcoming = (resolvedDate: string): CommitResult => {
        const id = writeMedicalRecord({
          doctor_name: doctorName,
          notes: raw,
          visit_date: resolvedDate,
          status: 'upcoming',
        });
        const verified = getMedicalRecords().some((r) => r.id === id);
        if (!verified) {
          return { status: 'failed', ack: "I'm having trouble holding onto that — say it once more?" };
        }
        const medicalAck = composeCaptureAck('medical_visit_upcoming', "I'll remind you.");
        // NOTE: buildCalendarCollectSlot treats the literal string
        // 'Appointment' as its own "title not yet known" sentinel
        // (calendarWrite.ts needsTitle check) — the no-doctor-name
        // fallback must not collide with it, or a nameless captured
        // visit would wrongly re-ask "what should I call this?" instead
        // of going straight to the time question.
        const title = doctorName ? `Appointment with ${doctorName}` : "Doctor's appointment";
        const collectPlan = buildCalendarCollectSlot(title, resolvedDate, '', writeCalendarCore);
        if (!collectPlan) {
          // Shouldn't happen (timeStr is always '' here), but never block
          // the already-verified medical commit on a calendar-side surprise.
          return { status: 'committed', ack: medicalAck };
        }
        return {
          status: 'pending',
          prompt: `${medicalAck} ${collectPlan.prompt}`,
          pendingKey: collectPlan.slot.pendingKey,
          reaskPrompt: collectPlan.slot.reaskPrompt,
          resume: collectPlan.slot.resume,
        };
      };

      const confirmStage = (resolvedDate: string): CommitResult => {
        const spoken = formatSpokenDate(resolvedDate);
        const who = doctorName ? ` with ${doctorName}` : '';

        // Duplicate-recognition gate (2026-08-09). Only checked when a
        // doctor name is known; exact match only, never fuzzy.
        if (doctorName) {
          const existing = findMatchingUpcomingAppointment(doctorName, resolvedDate);
          if (existing) {
            // Cancel words are checked ahead of NO so "cancel"/"never mind"
            // exit honestly without being misread as "different" — NO's
            // shared regex includes cancel words for the plain-decline
            // case elsewhere, but this branch repurposes NO to mean
            // "different appointment," so cancel must be intercepted
            // first, here only.
            const RECONCILE_CANCEL = /^(cancel|never ?mind|forget it|stop|nothing)[\s.,!]*$/i;
            const reconciliationResume = async (userText: string): Promise<CommitResult> => {
              const trimmed = userText.trim();
              if (RECONCILE_CANCEL.test(trimmed)) {
                return { status: 'noop', ack: "No problem — I won't do that." };
              }
              if (YES.test(trimmed)) {
                return { status: 'noop', ack: `Got it — I'll leave that as is.` };
              }
              if (NO.test(trimmed)) {
                return commitUpcoming(resolvedDate);
              }
              // Unresolved reply — stay inside reconciliation and re-ask
              // the same deterministic question rather than falling
              // through to generic Graceful Confusion, which was
              // observed abandoning the pending (2026-08-09 device test).
              return {
                status: 'pending',
                prompt: `I'm not sure I caught that — is this the same appointment with ${doctorName} ${spoken}, or a different one?`,
                pendingKey: 'medical_visit_upcoming_duplicate',
                resume: reconciliationResume,
              };
            };
            return {
              status: 'pending',
              prompt: `I already have you down for an appointment with ${doctorName} ${spoken} — is this the same one, or a different appointment?`,
              pendingKey: 'medical_visit_upcoming_duplicate',
              resume: reconciliationResume,
            };
          }
        }

        return {
          status: 'pending',
          prompt: `Say yes and I'll remember — appointment${who} ${spoken}.`,
          pendingKey: 'medical_visit_upcoming',
          resume: async (userText: string): Promise<CommitResult> => {
            if (NO.test(userText.trim())) {
              return { status: 'noop', ack: "No problem — tell me again and I'll get it right." };
            }
            if (!YES.test(userText.trim())) return { status: 'noop', ack: '' };
            return commitUpcoming(resolvedDate);
          },
        };
      };

      const parsedDate = parseDatePhrase(raw);
      if (parsedDate) return confirmStage(parsedDate);

      // No parseable date — one Graceful Confusion question. Never commit a
      // dateless 'upcoming' row (it could never surface and would rot).
      const who = doctorName ? ` with ${doctorName}` : '';
      return {
        status: 'pending',
        prompt: `I want to get this right — when is your appointment${who}?`,
        pendingKey: 'medical_visit_upcoming_date',
        resume: async (userText: string): Promise<CommitResult> => {
          const retryDate = parseDatePhrase(userText);
          if (!retryDate) return { status: 'noop', ack: '' };
          return confirmStage(retryDate);
        },
      };
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  diagnosis_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'diagnosis_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const condition = intent.condition?.trim();
      const raw = intent.raw ?? rawPhrase;
      if (!condition || condition.length < 2) {
        return { status: 'failed', ack: "I didn't catch that — what did the doctor say it was?" };
      }
      // Confirm-gate read-back: STT mangles long clinical phrases, and a wrong-
      // stored diagnosis is the worst failure Herald can make. Verify the exact
      // words before the write. No emotional overreach — capture honestly, gently.
      return {
        status: 'pending',
        prompt: `I want to make sure I have this exactly right — you said ${condition}?`,
        pendingKey: 'diagnosis_capture',
        resume: async (userText: string): Promise<CommitResult> => {
          const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|that'?s it|exactly|y)\b/i;
          const NO  = /^(no|nope|nah|wrong|not right|that'?s wrong|incorrect|cancel|nevermind|never mind)\b/i;
          if (NO.test(userText.trim())) {
            return { status: 'noop', ack: `No problem — tell me again and I'll get it right.` };
          }
          if (!YES.test(userText.trim())) {
            return { status: 'noop', ack: '' };
          }
          try {
            const { writeDiagnosis, getDiagnoses } = await import('../db/medicalDB');
            writeDiagnosis(condition, raw);
            const verified = getDiagnoses().some(
              d => (d.diagnosis ?? '').trim().toLowerCase() === condition.toLowerCase(),
            );
            if (!verified) {
              return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
            }
            return { status: 'committed', ack: composeCaptureAck('diagnosis_capture', `I'll remember that. You can ask me about it anytime.`) };
          } catch {
            return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
          }
        },
      };
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  doctor_intro_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'doctor_intro_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const name = intent.name?.trim();
      const specialty = intent.specialty?.trim();
      const raw = intent.raw ?? rawPhrase;
      if (!name || !specialty) {
        return { status: 'failed', ack: "I didn't catch that — who's your doctor and what's their specialty?" };
      }
      return {
        status: 'pending',
        prompt: `Say yes and I'll remember ${name} as your ${specialty}.`,
        pendingKey: 'doctor_intro_capture',
        resume: async (userText: string): Promise<CommitResult> => {
          const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|that'?s it|exactly|y)\b/i;
          const NO  = /^(no|nope|nah|wrong|not right|that'?s wrong|incorrect|cancel|nevermind|never mind)\b/i;
          if (NO.test(userText.trim())) {
            return { status: 'noop', ack: `No problem — tell me again and I'll get it right.` };
          }
          if (!YES.test(userText.trim())) {
            return { status: 'noop', ack: '' };
          }
          try {
            const { writeMedicalContact, getMedicalContacts, passesSubstringGate } = await import('../db/medicalDB');
            if (!passesSubstringGate(name, raw) || !passesSubstringGate(specialty, raw)) {
              return { status: 'failed', ack: "I want to make sure I get this exactly right — can you say that again?" };
            }
            writeMedicalContact({ name, specialty, is_primary: 0 });
            const verified = getMedicalContacts().some(
              c => c.name.trim().toLowerCase() === name.toLowerCase() &&
                   (c.specialty ?? '').trim().toLowerCase() === specialty.toLowerCase(),
            );
            if (!verified) {
              return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
            }
            return {
              status: 'committed',
              ack: composeCaptureAck('doctor_intro_capture', `I'll remember ${name} as your ${specialty}.`),
              // Same name-as-resolverKey convention as medical_visit above —
              // doctors have no opaque entity id in this schema.
              focus: { kind: 'person', displayValue: name, resolverKey: name, referable: true },
            };
          } catch {
            return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
          }
        },
      };
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  insurance_capture: {
    async add(intent: IntentRecord, _rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'insurance_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { insType, carrier } = intent as { insType?: string; carrier?: string };
      // Deterministic floor — never speak a model-echoed placeholder as a carrier.
      const BAD = /^(unknown|insurance_capture|insurance|none|null|n\/a)$/i;
      const cleanCarrier = normalizeCarrier((carrier ?? '').trim());
      const cleanType = (insType ?? '').trim().toLowerCase();
      const typeOk = cleanType.length >= 2 && !BAD.test(cleanType);
      const spokenType = typeOk ? cleanType : '';

      const commit = (finalCarrier: string, finalType: string): CommitResult => {
        const insId = captureHouseholdInsurance(finalType || 'unknown', finalCarrier);
        if (!insId) {
          return { status: 'failed', ack: "Hmm — I couldn't hold onto that just now. Mind telling me once more?" };
        }
        return {
          status: 'committed',
          ack: composeCaptureAck('insurance_capture', finalType
            ? `${finalCarrier} for your ${finalType} insurance.`
            : `${finalCarrier} for your insurance.`),
        };
      };

      const extractCarrier = (raw: string): string | null => {
        let t = raw.trim().replace(/[.!?]+$/, '');
        t = t.replace(/^(it'?s|that'?s|they'?re|the carrier is|i'?m with|we'?re with|with)\s+/i, '');
        // A fresh capture command is not a carrier answer — let the ladder re-ask.
        if (/^(my|our)\s+\w/i.test(t)) return null;
        if (/^(do|does|did|who|what|which|is|are|can|could|would|where|when|how)\b/i.test(t)) return null;
        const candidate = normalizeCarrier(t);
        if (candidate.length < 2 || BAD.test(candidate)) return null;
        return candidate;
      };

      // Correction/collection stage (R2): the pending owns the carrier answer.
      // It never routes fresh, never crosses a boundary (Law 2, Spine §3a).
      function askCarrierStage(finalType: string, prompt: string): CommitResult {
        return {
          status: 'pending',
          prompt,
          pendingKey: 'insurance_capture',
          kind: 'standard',
          reaskPrompt: `I'm not sure I'm following — who's your insurance with?`,
          resume: async (reply: string): Promise<CommitResult> => {
            const c = extractCarrier(reply);
            if (!c) return { status: 'noop', ack: '' }; // → primitive re-ask ladder
            return confirmStage(c, finalType);
          },
        };
      }

      function confirmStage(finalCarrier: string, finalType: string): CommitResult {
        return {
          status: 'pending',
          prompt: finalType
            ? `Got it — ${finalCarrier} for your ${finalType} insurance, right?`
            : `Got it — ${finalCarrier} insurance, right?`,
          pendingKey: 'insurance_capture',
          kind: 'standard',
          reaskPrompt: finalType
            ? `I'm not sure I'm following — is your ${finalType} insurance with ${finalCarrier}?`
            : `I'm not sure I'm following — is your insurance with ${finalCarrier}?`,
          resume: async (reply: string): Promise<CommitResult> => {
            const trimmed = reply.trim();
            const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
            if (CONFIRM_YES_RE.test(trimmed)) return commit(finalCarrier, finalType);
            if (CONFIRM_NO_RE.test(trimmed)) {
              return askCarrierStage(finalType, `No problem — what's the correct carrier?`);
            }
            return { status: 'noop', ack: '' }; // ambiguous → re-ask ladder, NEVER implicit NO
          },
        };
      }

      const carrierOk = cleanCarrier.length >= 2 && !BAD.test(cleanCarrier);
      if (!carrierOk) {
        return askCarrierStage(spokenType, `I didn't quite catch that — who's your insurance with?`);
      }
      return confirmStage(cleanCarrier, spokenType);
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  contact_call: {
    async add(intent: IntentRecord, _rawPhrase: string, ctx?: { resolveContact?: ResolveContactFn }): Promise<CommitResult> {
      if (intent.type !== 'contact_call') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { contact, candidates, devicePhone, deviceName, phonelessNames } = intent;
      type CallCandidate = { name: string; relationship?: string; phone: string; importance: number };

      // Identity-first: candidates are identity matches (phone may be empty).
      // Capability ('phone') is checked only after a single identity is chosen.
      const herald: CallCandidate[] = (candidates ?? []).map(c => ({
        name: c.name,
        relationship: c.relationship,
        phone: (c.phone ?? '').trim(),
        importance: c.importance,
      }));

      const handleFor = (c: CallCandidate): string =>
        c.relationship?.trim()
          ? `your ${c.relationship} ${c.name}`
          : (c.phone.replace(/\D/g, '').length >= 4
            ? `at ...${c.phone.replace(/\D/g, '').slice(-4)}`
            : c.name);

      const joinNaturally = (items: string[]): string => {
        if (items.length === 0) return '';
        if (items.length === 1) return items[0];
        if (items.length === 2) return `${items[0]} and ${items[1]}`;
        return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
      };

      const commitDial = (name: string, phone: string, ack?: string): CommitResult => {
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 10) {
          return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
        }
        return {
          status: 'committed',
          ack: ack ?? `Calling ${name}.`,
          effect: {
            kind: 'dial',
            phone: digits,
            failAck: `I couldn't open the dialer — try calling ${name} manually.`,
          },
        };
      };

      const disclosureAck = (dialName: string, dropped: string[]): string => {
        const rel = contact.trim().replace(/^(?:my|the|a)\s+/i, '');
        const relIsNameEcho = (() => {
          if (!rel) return true;
          const r = rel.toLowerCase();
          const tokensOf = (s: string) =>
            s.trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
          return [dialName, ...dropped].some(n => tokensOf(n).includes(r));
        })();
        const asRel = relIsNameEcho ? '' : ` as your ${rel}`;
        if (dropped.length === 1) {
          return `Calling ${dialName}. I also know ${dropped[0]}${asRel}, but I don't have a number for ${dropped[0]} yet.`;
        }
        if (dropped.length === 2) {
          return `Calling ${dialName}. I also know ${joinNaturally(dropped)}${asRel}, but I don't have their numbers yet.`;
        }
        // 3+: speak two names, then "and N others" — noise guard
        const spoken = joinNaturally(dropped.slice(0, 2));
        const others = dropped.length - 2;
        return `Calling ${dialName}. I also know ${spoken}, and ${others} other${others === 1 ? '' : 's'}, but I don't have their numbers yet.`;
      };

      const CORRECTION_STOPWORDS = new Set([
        'no', 'nope', 'not', 'yes', 'yeah', 'my', 'the', 'a', 'an', 'is', 'was',
        'it', "it's", 'its', 'that', "that's", 'thats', 'his', 'her', 'their',
        'actually', 'i', 'mean', 'think',
      ]);

      const matchCandidate = (
        reply: string,
        list: CallCandidate[],
        contactLabel?: string,
      ): CallCandidate | null => {
        const labelTokens = new Set(
          (contactLabel ?? '').trim().toLowerCase().replace(/[\s-]+/g, ' ').split(' ').filter(Boolean)
        );
        // Hyphen-split reply like labelTokens; rarer hyphenated surnames in replies may miss.
        const replyTokens = reply.trim().toLowerCase().replace(/[\s-]+/g, ' ').split(' ').filter(Boolean)
          .filter(t => !CORRECTION_STOPWORDS.has(t) && !labelTokens.has(t));
        if (replyTokens.length === 0) {
          // Label strip emptied the reply (e.g. contactLabel "dad" + reply "My Dad").
          // Reuse matchCandidateToken against stored display names — same grammar as
          // SMS pending — so the displayed candidate still binds exactly.
          const tokenMatch = matchCandidateToken(
            reply,
            list.map(c => ({ label: c.name, ref: c.name, phone: c.phone })),
          );
          if (tokenMatch === 'ambiguous' || tokenMatch === 'none') return null;
          return list.find(c => c.name === tokenMatch.ref) ?? null;
        }
        const hits = list.filter(c => {
          const nameTokens = c.name.trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
          const relTokens = (c.relationship ?? '').trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
          const pool = [...nameTokens, ...relTokens];
          return replyTokens.every(t => pool.includes(t));
        });
        if (hits.length === 1) return hits[0];
        return null;
      };

      const finitePhoneableCallPending = (
        rows: CallCandidate[],
        contactLabel: string,
        prompt: string,
        onUnique: (picked: CallCandidate) => CommitResult,
      ): CommitResult => {
        const identityNames = rows.map(r => r.name.trim()).filter(Boolean);
        const identityCount = identityNames.length;
        const byName = new Map<string, CallCandidate>();
        for (const row of rows) {
          const name = row.name.trim();
          if (name && row.phone?.trim() && !byName.has(name)) byName.set(name, row);
        }
        // Genuine singular identity may still complete. Two-plus identities
        // with one phoneable row is ambiguity, not a unique CALL.
        if (identityCount < 2 && byName.size === 1) {
          return onUnique([...byName.values()][0]!);
        }
        if (byName.size === 0) {
          return collectStage(contactLabel);
        }
        const onlyPhoneable = byName.size === 1 ? [...byName.values()][0]! : null;
        const confirmOneAmongMany = identityCount >= 2 && onlyPhoneable != null;
        let task: CallTextTask = {
          action: 'call',
          contactName: '',
          message: '',
          candidateNames: confirmOneAmongMany
            ? [...new Set(identityNames)]
            : [...byName.keys()],
          spokenQuery: contactLabel,
          proposedNames: confirmOneAmongMany ? [onlyPhoneable!.name.trim()] : [],
          gap: 'ambiguous_person',
          turnsAsked: 1,
          failedMatchTurns: 0,
        };
        const spoken = contactLabel.trim() || 'people';
        const initialPrompt = confirmOneAmongMany
          ? `I found more than one ${spoken}. I only have a number for ${onlyPhoneable!.name}. Did you mean ${onlyPhoneable!.name}?`
          : prompt;
        const liveRows = (): CallCandidate[] =>
          task.candidateNames.map(n => byName.get(n)).filter((c): c is CallCandidate => !!c);

        const resume = async (pick: string): Promise<CommitResult> => {
          const matched = matchCandidate(pick, liveRows(), contactLabel);
          if (matched) return onUnique(matched);
          let r = advanceFiniteCandidateRecovery(task, pick, {
            fullSetTokenHit: 'retain',
            uniqueTokenHit: 'defer_miss',
          });
          if (r.kind === 'non_advance' || r.kind === 'stop') {
            r = holdUnresolvedRecovery(task);
          }
          if (r.kind === 'pending') {
            task = r.task;
            return {
              status: 'pending',
              prompt: r.prompt,
              pendingKey: 'contact_call',
              kind: 'standard',
              reaskPrompt: r.prompt,
              budget: RECOVERY_BUDGET,
              releasePrompt: CAPTURE_SECOND_MISS,
              resume,
              recoveryChoices: r.recoveryChoices,
            };
          }
          const name = r.task.contactName.trim();
          const row = byName.get(name);
          if (row) return onUnique(row);
          return collectStage(name || contactLabel);
        };

        return {
          status: 'pending',
          prompt: initialPrompt,
          pendingKey: 'contact_call',
          kind: 'standard',
          reaskPrompt: initialPrompt,
          budget: RECOVERY_BUDGET,
          releasePrompt: CAPTURE_SECOND_MISS,
          resume,
        };
      };

      const extractPhone10 = (raw: string): string | null => {
        const m = raw.match(/([\d\s\-\(\)\+\.]{7,})/);
        if (!m) return null;
        const digits = m[1].replace(/\D/g, '');
        if (digits.length !== 10) return null;
        return digits;
      };

      function collectStage(contactLabel: string, opts?: { knownPerson?: boolean }): CommitResult {
        const known = opts?.knownPerson === true;
        const collectPrompt = known
          ? `I know ${contactLabel} but I don't have a phone number for them. What's their number?`
          : `I don't have a number for ${contactLabel} yet — what's their name, or you can give me the number?`;

        return {
          status: 'pending',
          prompt: collectPrompt,
          pendingKey: 'contact_call',
          kind: 'standard',
          reaskPrompt: known
            ? `I'm not sure I'm following — what's ${contactLabel}'s number?`
            : `I'm not sure I'm following — what's your ${contactLabel}'s name, or their number?`,
          resume: async (reply: string): Promise<CommitResult> => {

            const phone = extractPhone10(reply);
            if (phone) {

              const writeResult = capturePerson({ name: contactLabel, phone, importance: 7 });
              return commitDial(
                contactLabel,
                phone,
                writeResult.ok
                  ? undefined
                  : `Calling your ${contactLabel} now. Tell me their name sometime and I'll remember them for next time.`,
              );
            }
            const lookupTarget = known ? extractCollectContactNameReference(reply) : reply;
            if (known && !lookupTarget) {
              return { status: 'noop', ack: '' };
            }
            const osQuery = refineOsNameQuery(contactLabel, lookupTarget!);
            const replyIdentity = resolvePersonIdentity(osQuery || lookupTarget!);
            if (replyIdentity.status === 'single' && contactHasCapability(replyIdentity.contact, 'phone')) {
              const match = replyIdentity.contact;

              if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                retireRelationshipHolder(contactLabel, match.name);
                capturePerson({ name: match.name, relationship: contactLabel, phone: match.phone!, importance: 7 });
                return commitDial(match.name, match.phone!);
              }
              return commitDial(match.name, match.phone!);
            }
            // Herald doesn't know this name yet — try the OS contact book,
            // the same fallback resolveContactCallIntent already uses at
            // initial routing. Reached here because the first ask had zero
            // candidates of either kind.
            if (ctx?.resolveContact) {
              const device = await ctx.resolveContact(osQuery || lookupTarget!);
              const osLookup = osQuery || lookupTarget!;
              if (device && device.phone && osNameFullyCovered(osLookup, device.name)) {

                if (known) {
                  return commitDial(device.name, device.phone);
                }
                if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                  retireRelationshipHolder(contactLabel, device.name);
                  capturePerson({ name: device.name, relationship: contactLabel, phone: device.phone, importance: 7 });
                  return commitDial(device.name, device.phone);
                }
                return commitDial(device.name, device.phone);
              }
                if (device && !device.phone && 'deviceCandidates' in device && device.deviceCandidates.length > 0) {
                  const osCandidates: CallCandidate[] = device.deviceCandidates.map(c => ({
                    name: c.name,
                    phone: c.phone,
                    importance: 5,
                  }));
                  const names = joinNaturally(osCandidates.map(c => c.name));
                  const nestedPrompt = `I found a few in your contacts — ${names} — which one?`;
                  return finitePhoneableCallPending(osCandidates, contactLabel, nestedPrompt, (picked) => {
                    if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                      retireRelationshipHolder(contactLabel, picked.name);
                      capturePerson({ name: picked.name, relationship: contactLabel, phone: picked.phone, importance: 7 });
                    }
                    return commitDial(picked.name, picked.phone);
                  });
                }
            }

            return { status: 'noop', ack: '' };
          },
        };
      }

      function knownPersonOsConfirmStage(name: string, phone: string, heraldContactId?: string): CommitResult {
        const LOOSE_YES_RE = /^\s*(yes|yeah|yep|sure|ok|okay|go ahead|call them|do it)\b/i;
        const LOOSE_NO_RE = /^\s*(no|nope|cancel|never mind|nevermind|don't|dont|stop)\b/i;
        const confirmPrompt = `I found ${name} in your contacts — is that who you meant?`;

        return {
          status: 'pending',
          prompt: confirmPrompt,
          pendingKey: 'contact_call',
          kind: 'standard',
          reaskPrompt: `I'm not sure I'm following — is that who you meant?`,
          resume: async (reply: string): Promise<CommitResult> => {

            const trimmed = reply.trim();
            if (LOOSE_YES_RE.test(trimmed)) {
              if (heraldContactId) {
                const attachResult = attachPhoneToContactById(heraldContactId, phone);
                if (!attachResult.ok) {
                  console.warn('[contact_call] attachPhoneToContactById failed:', attachResult.reason);
                }
              }
              return commitDial(name, phone);
            }
            if (LOOSE_NO_RE.test(trimmed)) {
              return { status: 'noop', ack: 'No problem — who were you trying to reach?' };
            }

            return { status: 'noop', ack: '' };
          },
        };
      }

      function deviceConfirmStage(name: string, phone: string): CommitResult {
        const LOOSE_YES_RE = /^\s*(yes|yeah|yep|sure|ok|okay|go ahead|call them|do it)\b/i;
        const LOOSE_NO_RE = /^\s*(no|nope|cancel|never mind|nevermind|don't|dont|stop)\b/i;
        const confirmPrompt = `I found ${name} in your contacts — want me to call them?`;

        return {
          status: 'pending',
          prompt: confirmPrompt,
          pendingKey: 'contact_call',
          kind: 'standard',
          reaskPrompt: `I'm not sure I'm following — should I call ${name}?`,
          resume: async (reply: string): Promise<CommitResult> => {

            const trimmed = reply.trim();
            if (LOOSE_YES_RE.test(trimmed)) {

              capturePerson({ name, phone, importance: 5 });
              return commitDial(name, phone);
            }
            if (LOOSE_NO_RE.test(trimmed)) {

              return { status: 'noop', ack: 'No problem — who were you trying to reach?' };
            }

            return { status: 'noop', ack: '' };
          },
        };
      }

      function disambiguateStage(list: CallCandidate[], contactLabel: string): CommitResult {
        const hasRelationshipEvidence = list.some(c => c.relationship?.trim());
        if (!hasRelationshipEvidence) {
          // ≥2 phoneable candidates with no relationship-field evidence — name
          // them all and ask, whether the spoken reference was a relationship
          // word or a plain name (state doc §9). Never top-1, never write a
          // relationship from this path. Keep the generic "I don't know who
          // your …" prompt below for zero/no-phone cases.
          const allPhoneable =
            list.length >= 2 && list.every(c => !!c.phone?.trim());
          const onePhoneableAmongMany =
            list.length >= 2 && list.filter(c => !!c.phone?.trim()).length === 1;
          if (allPhoneable || onePhoneableAmongMany) {
            const names = joinNaturally(list.map(c => c.name));
            const prompt = `I found a few in your contacts — ${names} — which one?`;
            return finitePhoneableCallPending(list, contactLabel, prompt, (picked) => {
              if (picked.phone?.trim()) return commitDial(picked.name, picked.phone);
              return collectStage(picked.name);
            });
          }

          const genericPrompt = `I don't know who your ${contactLabel} is yet — what's their last name, or you can just give me the number?`;


          return {
            status: 'pending',
            prompt: genericPrompt,
            pendingKey: 'contact_call',
            kind: 'standard',
            reaskPrompt: `I'm not sure I'm following — what's your ${contactLabel}'s last name, or their number?`,
            resume: async (reply: string): Promise<CommitResult> => {

              const phone = extractPhone10(reply);
              if (phone) {

                const writeResult = capturePerson({ name: contactLabel, phone, importance: 7 });
                return commitDial(
                  contactLabel,
                  phone,
                  writeResult.ok
                    ? undefined
                    : `Calling your ${contactLabel} now. Tell me their name sometime and I'll remember them for next time.`,
                );
              }
              const matched = matchCandidate(reply, list, contactLabel);
              if (matched) {
                // Persist the correction — contactLabel is only a real relationship
                // word sometimes (e.g. "father-in-law"); other times this same branch
                // fires for a plain-name lookup (e.g. "call sarah" with several device
                // matches), where contactLabel is a name, not a relationship, and must
                // NOT be written into the relationship field.
                if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                  // The user just explicitly confirmed matched.name holds this
                  // relationship — retire any other live holder before writing the new
                  // one, so a current-value relationship never has two active answers
                  // (Spine §6 principle 3). This is the explicit-confirmation case Spine
                  // §4a permits; writeContact's own identity-key logic stays untouched.

                  retireRelationshipHolder(contactLabel, matched.name);
                  capturePerson({ name: matched.name, relationship: contactLabel, phone: matched.phone, importance: 7 });
                  return commitDial(matched.name, matched.phone);
                }

                return commitDial(matched.name, matched.phone);
              }
              // The reply named someone NOT in this pre-built candidate list —
              // a genuinely new name. Same fallback ladder as collectStage: try
              // Herald's own contacts fresh, then the OS contact book.
              const freshIdentity = resolvePersonIdentity(reply);
              if (freshIdentity.status === 'single' && contactHasCapability(freshIdentity.contact, 'phone')) {
                const fresh = freshIdentity.contact;
                if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {

                  retireRelationshipHolder(contactLabel, fresh.name);
                  capturePerson({ name: fresh.name, relationship: contactLabel, phone: fresh.phone!, importance: 7 });
                  return commitDial(fresh.name, fresh.phone!);
                }

                return commitDial(fresh.name, fresh.phone!);
              }
              if (ctx?.resolveContact) {
                const osLookup = refineOsNameQuery(contactLabel, reply);
                const device = await ctx.resolveContact(osLookup);
                if (device && device.phone && osNameFullyCovered(osLookup, device.name)) {

                  if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                    retireRelationshipHolder(contactLabel, device.name);
                    capturePerson({ name: device.name, relationship: contactLabel, phone: device.phone, importance: 7 });
                    return commitDial(device.name, device.phone);
                  }
                  return commitDial(device.name, device.phone);
                }
                if (device && !device.phone && 'deviceCandidates' in device && device.deviceCandidates.length > 0) {
                  const osCandidates: CallCandidate[] = device.deviceCandidates.map(c => ({
                    name: c.name,
                    phone: c.phone,
                    importance: 5,
                  }));
                  const names = joinNaturally(osCandidates.map(c => c.name));
                  const nestedPrompt = `I found a few in your contacts — ${names} — which one?`;
                  return finitePhoneableCallPending(osCandidates, contactLabel, nestedPrompt, (picked) => {
                    if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                      retireRelationshipHolder(contactLabel, picked.name);
                      capturePerson({ name: picked.name, relationship: contactLabel, phone: picked.phone, importance: 7 });
                    }
                    return commitDial(picked.name, picked.phone);
                  });
                }
              }

              return { status: 'noop', ack: '' };
            },
          };
        }

        const guess = list[0];
        const relPrefix = guess.relationship?.trim() ? `your ${guess.relationship} ` : '';
        const relEvidencePrompt = `I've got more than one ${contactLabel} — did you mean ${relPrefix}${guess.name}?`;

        return {
          status: 'pending',
          prompt: relEvidencePrompt,
          pendingKey: 'contact_call',
          kind: 'standard',
          reaskPrompt: `I'm not sure I'm following — which ${contactLabel} did you mean?`,
          resume: async (reply: string): Promise<CommitResult> => {

            const trimmed = reply.trim();
            const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
            const dialOrCollect = (c: CallCandidate): CommitResult =>
              c.phone?.trim() ? commitDial(c.name, c.phone) : collectStage(c.name);
            if (CONFIRM_YES_RE.test(trimmed)) {

              return dialOrCollect(guess);
            }
            if (CONFIRM_NO_RE.test(trimmed)) {
              const remaining = list.slice(1);
              if (remaining.length === 0) {

                return collectStage(contactLabel);
              }
              const handles = remaining.map(handleFor).join(', ');
              const altPrompt = `No problem — I've also got ${handles}. Which one?`;

              return {
                status: 'pending',
                prompt: altPrompt,
                pendingKey: 'contact_call',
                kind: 'standard',
                reaskPrompt: `I'm not sure I'm following — which one did you mean?`,
                resume: async (pick: string): Promise<CommitResult> => {

                  const matched = matchCandidate(pick, remaining, contactLabel);
                  if (!matched) {

                    return { status: 'noop', ack: '' };
                  }

                  return dialOrCollect(matched);
                },
              };
            }
            const named = matchCandidate(trimmed, list, contactLabel);
            if (named) {

              return dialOrCollect(named);
            }

            return { status: 'noop', ack: '' };
          },
        };
      }

      if (herald.length > 1) return disambiguateStage(herald, contact);
      if (herald.length === 1) {
        const only = herald[0];
        if (!only.phone?.trim()) {
          return collectStage(only.name, { knownPerson: true });
        }
        // phonelessNames retained on IntentRecord for back-compat; disclosure only
        // when resolver still supplies it (identity-first path normally does not).
        const dropped = (phonelessNames ?? []).map(n => n.trim()).filter(Boolean);
        if (dropped.length > 0) {
          return commitDial(only.name, only.phone, disclosureAck(only.name, dropped));
        }
        return commitDial(only.name, only.phone);
      }
      const phone = devicePhone?.trim();
      if (phone) {
        const name = deviceName?.trim() || contact;
        return deviceConfirmStage(name, phone);
      }
      return collectStage(contact);
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
};

// allConverted: returns true when every intent in a capture decision has a
// registered writer. Gates the new dispatch path; false = legacy path runs.
export function allConverted(intents: IntentRecord[]): boolean {
  return intents.every(i => i.type in DOMAIN_WRITERS);
}

// ─── Deterministic capture-acknowledgment composer ───────────────────────────
// Herald feels robotic — capture-ack repetition finding, 2026-08-12.
//
// Variation is derived ONLY from intent.type, which every DOMAIN_WRITER
// already receives as a parameter — no new metadata, no regex, no keyword
// matching on any string, no randomness, no LLM. This function never touches,
// normalizes, paraphrases, or infers the user-derived value inside `body` —
// it only decides whether a fixed, Memory-Language-Rule-compliant connector
// precedes an already-complete body.
//
// Most capture bodies are already complete, specific statements on their own
// (North Star §1, "Specific") — a generic lead-in prefix in front of them
// was redundant scaffolding, not acknowledgment. phone_capture and
// insurance_capture are the two types whose body is a genuine fragment (a
// bare name-at-number pairing / a bare noun phrase, no verb) — those keep a
// fixed connector. This function is only ever called on an already-committed
// capture's `ack` string — every `status: 'pending'` confirmation prompt in
// this file is untouched by this change.
const CAPTURE_ACK_CONNECTOR: Partial<Record<IntentRecord['type'], string>> = {
  phone_capture: 'Noted — ',
  insurance_capture: 'Noted — ',
};

export function composeCaptureAck(type: IntentRecord['type'], body: string): string {
  const connector = CAPTURE_ACK_CONNECTOR[type];
  return connector ? `${connector}${body}` : body;
}

// Presentation-only capitalization for the one spoken sentence where a
// captured list item becomes sentence-initial for the first time. Never
// touches the stored item, raw_phrase, dedupe/matching, or read-back — those
// all continue to use the item exactly as captured. Scoped to a single call
// site (list_add, single-item ack); not a general normalizer.
function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

// composeAck: builds the spoken ACK from verified CommitResults only.
// v1: one result → its ack. Multiple: join committed/noop acks naturally.
// A pending result surfaces its prompt; never presents pending as committed.
export function composeAck(results: CommitResult[]): string {
  if (results.length === 0) return "I couldn't hold onto that — say it once more?";
  if (results.length === 1) return results[0].status === 'pending'
    ? results[0].prompt
    : results[0].ack;
  const pending = results.find(r => r.status === 'pending');
  const settled = results
    .filter(r => r.status !== 'pending')
    .map(r => r.ack)
    .filter(Boolean)
    .join(' ');
  if (pending && pending.status === 'pending') {
    return settled ? `${settled} ${pending.prompt}` : pending.prompt;
  }
  return settled;
}

// Law 5 (Spine §3a) fail-closed classification helper. A 'capture' decision
// that reached this point without a registered writer is PERSONAL by
// construction — it only exists because a personal-domain utterance missed
// every deterministic net. Any exception encountered while further
// classifying such an utterance must terminate locally, never reach the
// network. An explicit live-data authorization (kind: 'backend') is
// unaffected by this check.
export function isUnresolvedPersonalCapture(decision: RouteDecision): boolean {
  return decision.kind === 'capture';
}

function medicationSemanticCaptureDecision(
  text: string,
  proposal: import('./medicationSemanticInterpretation').SemanticProposal,
): RouteDecision | null {
  const admission = admitMedicationSemanticProposal(text, proposal, { hasPending: false });
  if (admission.decision !== 'ADMIT') return null;
  return {
    kind: 'capture',
    intents: [{
      type: 'medical_capture',
      drug: admission.drug,
      dosage: admission.dosage,
      frequency: admission.frequency,
      raw: text,
    }],
    source: 'llm',
    reason: 'semantic_proposal:medication_admit',
  };
}

async function tryMedicationSemanticCaptureRoute(
  text: string,
  getCtx: () => LlamaContext | null,
): Promise<RouteDecision | null> {
  const generation = await generateMedicationSemanticProposal(text, getCtx);
  if (generation.status !== 'ok') return null;
  return medicationSemanticCaptureDecision(text, generation.proposal);
}

function todoSemanticP2Decision(
  text: string,
  proposal: import('./todoSemanticCapture').TodoSemanticProposal,
): RouteDecision | null {
  const admission = admitTodoSemanticP2(text, proposal, { hasPending: false });
  if (admission.decision === 'CLARIFY') {
    return { kind: 'needs_clarification', reason: 'semantic_proposal:todo_clarify' };
  }
  if (admission.decision !== 'ADMIT') return null;
  console.warn('[todoSemanticCapture] ' + JSON.stringify({
    event: 'confirmation_required',
    admissionClass: 'P2',
    candidateCount: admission.candidates.length,
  }));
  return {
    kind: 'capture',
    intents: admission.candidates.map((body) => ({ type: 'todo_add' as const, body })),
    source: 'llm',
    reason: 'semantic_proposal:todo_admit',
  };
}

async function tryTodoSemanticP2Route(
  text: string,
  getCtx: () => LlamaContext | null,
): Promise<RouteDecision | null> {
  const generation = await generateTodoSemanticProposal(text, getCtx);
  if (generation.status !== 'ok') return null;
  return todoSemanticP2Decision(text, generation.proposal);
}

function grocerySemanticP2Decision(
  text: string,
  proposal: import('./grocerySemanticDecomposition').GrocerySemanticProposal,
): RouteDecision | null {
  const admission = admitGrocerySemanticP2(text, proposal, { hasPending: false });
  if (admission.decision !== 'ADMIT') return null;
  console.warn('[grocerySemanticDecomposition] ' + JSON.stringify({
    event: 'confirmation_required',
    admissionClass: 'P2',
    candidateCount: admission.candidates.length,
  }));
  return {
    kind: 'capture',
    intents: [{
      type: 'list_add',
      items: admission.candidates,
      listName: 'grocery',
    }],
    source: 'llm',
    reason: 'semantic_proposal:grocery_admit',
  };
}

async function tryGrocerySemanticP2Route(
  text: string,
  getCtx: () => LlamaContext | null,
): Promise<RouteDecision | null> {
  const generation = await generateGrocerySemanticProposal(text, getCtx);
  if (generation.status !== 'ok') return null;
  return grocerySemanticP2Decision(text, generation.proposal);
}

async function admitWiredMedicationRead(proposal: { capability: CapabilityId; confidence: 'high' | 'medium' | 'low' }): Promise<RouteDecision | null> {
  const admission = admitCapabilityProposal(proposal);
  if (admission.decision === 'ADMIT_READ') {
    const { composeMedicalSummary } = await import('../db/medicalDB');
    const summary = composeMedicalSummary();
    return {
      kind: 'device_read',
      tier: 1,
      response: summary.response,
      isMedical: true,
      reason: 'medical:summary',
      presentedMedicationIds: summary.medicationIds,
    };
  }
  if (proposal.capability === WIRED_READ_CAPABILITY) {
    return { kind: 'needs_clarification', reason: 'personal_memory:recall_declined' };
  }
  return null;
}

export async function routeIntent(
  text: string,
  deps: {
    classifyQuery: (msg: string) => Promise<TierDecision>;
    classifyLLM: ((text: string) => Promise<ClassifyOutcome>) | null;
    llmReady: boolean;
    /** When 'loading', tier-3 fallthrough without classify must be not_ready (honest waking-up), not needs_clarification. */
    llmStatus?: 'unavailable' | 'loading' | 'ready' | 'error';
    captureContext?: CaptureContext;
    resolveContact?: (nameOrRelation: string) => Promise<{phone:string;name:string;contactId?:string;source:'herald'|'device'}|{phone:null;name:string;source:'device';candidateNames:string[];deviceCandidates:{name:string;phone:string}[]}|null>;
    /** Medication Semantic Interpretation V1 seam only. Injected accessor for
     *  the interpreter's own model context — independent of classifyLLM/
     *  llmReady above. Omitted or returning null => the seam treats the
     *  interpreter as unavailable and falls through unchanged. */
    getMedicationSemanticInterpreterCtx?: () => LlamaContext | null;
    /** Test/injection override. Omitted ⇒ features.ts GROCERY_SEMANTIC_DECOMPOSITION_ENABLED. */
    grocerySemanticDecompositionEnabled?: boolean;
    /** Test/injection override. Omitted ⇒ features.ts SEMANTIC_CAPABILITY_DISPATCH_ENABLED. */
    semanticCapabilityDispatchEnabled?: boolean;
    /** Test/injection override. Omitted ⇒ features.ts CAPABILITY_READ_ROUTER_ENABLED. */
    capabilityReadRouterEnabled?: boolean;
    /** Test/injection override. Omitted ⇒ features.ts MEDICATION_SEMANTIC_INTERPRETATION_ENABLED. */
    medicationSemanticInterpretationEnabled?: boolean;
    /** Test/injection override. Omitted ⇒ features.ts NATURAL_MULTI_FACT_INTERPRETATION_ENABLED. */
    naturalMultiFactInterpretationEnabled?: boolean;
    /** Test-only proposer. Omitted ⇒ deterministic utterance proposer. */
    proposeNaturalMultiFact?: (text: string) => MultiFactProposalGenerationResult;
  },
): Promise<RouteDecision> {
  const routeT0 = latMono();
  const turnId = getActiveTurnId();
  latLog('routeIntent START', { turnId });
  let dispatchDiag: (Omit<SemanticDispatchDiag, 'finalOutcome'> & { finalOutcome?: SemanticDispatchDiag['finalOutcome'] }) | null = null;
  try {
  const decision = await deps.classifyQuery(text);
  console.log('[classifyQuery]', JSON.stringify({ tier: decision.tier, actionIntent: decision.actionIntent, reason: decision.reason }));

  // NEW: medical visit-outcome disambiguation pending. Intercepts before
  // the generic device_read mapping below so this one reason arms a
  // resumable pending instead of a one-shot read. tierRouter/classifyQuery
  // itself is untouched.
  if (decision.tier === 1 && decision.reason === 'medical:visit_outcome_multiple_doctors') {
    const { buildMedicalVisitOutcomePending } = await import('./medicalVisitOutcomeDisambiguate');
    return {
      kind: 'medical_read_pending',
      pending: buildMedicalVisitOutcomePending(),
      reason: decision.reason,
    };
  }

  if (decision.tier === 1 && typeof decision.tier1Response === 'string') {
    return {
      kind: 'device_read',
      tier: 1,
      response: decision.tier1Response,
      isMedical: decision.isMedical,
      reason: decision.reason,
      presentedMedicationIds: decision.presentedMedicationIds,
      presentedCalendarEventIds: decision.presentedCalendarEventIds,
    };
  }

  if (decision.tier === 1 && decision.actionIntent) {
    const actionType = decision.actionIntent.type;
    // All medical_capture (medication, visit, advice) skips device_action and
    // flows to the capture path → DOMAIN_WRITERS. Visits/advice were previously
    // routed to dispatch's medical_capture branch; that island is retired (V4).
    const isMedicalCapture = actionType === 'medical_capture';
    // S64 D5: typeless insurance statements classify as profile_update at tier-1.
    // They are captures of a correction-prone fact (§4 confirm-before-save) and
    // must reach the insurance writer — never an unconfirmed local_profile write
    // into a table householdRead never reads. field 'provider' is NOT diverted
    // ("my provider is Dr. Smith" is not insurance). Dual-write audit: carried.
    const isInsuranceProfileUpdate =
      decision.actionIntent.type === 'profile_update' &&
      decision.actionIntent.field === 'insurance';
    if (actionType === 'call') {
      const rawContact = (decision.actionIntent as any).contact ?? '';
      const contactName = rawContact.replace(/\s+(?:at|on|using|with|via)\b.*/i, '').trim();
      if (contactName) {
        const intent = await resolveContactCallIntent(contactName, text, deps);
        return { kind: 'capture', intents: [intent], source: 'deterministic', reason: 'routeIntent:contact_call_intercept' };
      }
    }
    if (actionType === 'list_read') {
      const listName = decision.actionIntent.type === 'list_read'
        ? decision.actionIntent.listName
        : 'grocery';
      const { getPresentedOpenListItems, composeOpenListSpeech } = await import('../db/listRead');
      const items = getPresentedOpenListItems(listName);
      return {
        kind: 'device_read',
        tier: 1,
        response: composeOpenListSpeech(listName, items),
        reason: decision.reason,
        ...(listName === 'grocery' ? { presentedGroceryIds: items.map((i) => i.id) } : {}),
      };
    }
    if (actionType === 'todo_read') {
      const { getPresentedOpenListItems, composeTodoOpenSpeech } = await import('../db/listRead');
      const items = getPresentedOpenListItems('todos');
      return {
        kind: 'device_read',
        tier: 1,
        response: composeTodoOpenSpeech(items),
        reason: decision.reason,
        presentedTodoIds: items.map((i) => i.id),
      };
    }
    if (actionType === 'todo_complete') {
      const raw = decision.actionIntent.type === 'todo_complete'
        ? (decision.actionIntent.raw ?? text)
        : text;
      return {
        kind: 'capture',
        intents: [{ type: 'todo_complete', raw }],
        source: 'deterministic',
        reason: decision.reason,
      };
    }
    if (actionType !== 'list_add' && actionType !== 'todo_add' && !isMedicalCapture && !isInsuranceProfileUpdate) {
      return {
        kind: 'device_action',
        tier: 1,
        actionIntent: decision.actionIntent,
        reason: decision.reason,
      };
    }
  }

  if (decision.tier === 2) {
    return {
      kind: 'memory_probe',
      tier: 2,
      context: decision.localContext ?? { intent: 'memory_probe' },
      reason: decision.reason,
    };
  }

  // Tier-2 deterministic capture floor (spec §2.3 step 3). Reached only at tier 3
  // (tier-1/tier-2 already returned above), so the invariant holds: no LLM capture
  // is ever selected when a deterministic result exists.
  const capCtx: CaptureContext = deps.captureContext ?? { contacts: [], lists: [] };
  // D-phone-repair, 2026-08-13: computed once, up front, so both the
  // unchanged-precedence capturer loop below and the repair fallthrough
  // can consume the same result without a second regex pass.
  const phoneResult = detectPhoneCapture(text, capCtx.contacts);
  const CAPTURERS_WITH_PHONE: DeterministicCapturer[] = [
    (text) => detectDoctorIntroCapture(text),
    (text) => detectInsuranceCapture(text),
    (text) => detectServiceCapture(text),
    () => (phoneResult.kind === 'valid' ? [phoneResult.intent] : []),
    (text) => detectDiagnosisCapture(text),
    (text) => detectFamilyCapture(text),
  ];
  for (const capture of CAPTURERS_WITH_PHONE) {
    const intents = capture(text, capCtx);
    if (intents.length > 0) {
      return { kind: 'capture', intents, source: 'deterministic', reason: 'deterministic:capture' };
    }
  }

  // Reached only if nothing above claimed the utterance. A matched-but-
  // invalid phone attempt is deterministic-only -- it is NEVER represented
  // as an IntentRecord (not classifier-visible), and this check runs
  // strictly before the LLM tier-3 branch below, so the LLM can never
  // trigger phone repair.
  if (phoneResult.kind === 'matched_invalid') {
    const capturedName = phoneResult.name;
    return {
      kind: 'phone_repair_needed',
      reason: 'deterministic:phone_repair',
      pending: {
        status: 'pending',
        prompt: 'I may have missed a digit. Can you say the number again?',
        pendingKey: 'phone_capture_repair',
        // D-phone-repair polish, 2026-08-13: reaskPrompt fires only on the
        // retry-after-the-retry (ConversationSession's budget-decrement
        // path, conversationSession.ts). At that point the digits actually
        // heard on THIS attempt live only inside resume()'s local `retry`
        // and are discarded on an invalid CommitResult -- CommitResult's
        // 'noop' variant carries no extra fields and resolvePending reads
        // none, so an exact count is not truthfully available here without
        // widening that contract (out of scope for this slice). Wording is
        // therefore deliberately count-free and never implies which or how
        // many digits are missing.
        reaskPrompt: "I still didn't get a complete phone number — try saying it once more, slowly.",
        resume: async (userText: string): Promise<CommitResult> => {
          const retry = normalizePhone(userText);
          if (!retry.valid) {
            return { status: 'noop', ack: '' };
          }
          // D-phone-repair M1 completion (Fix A), 2026-08-13: a structurally
          // valid retry is still only a candidate, not evidence it's correct
          // — same trust boundary the fresh phone_capture path already
          // enforces via buildPhoneConfirmPending. It must not commit here.
          const formattedPhone = formatPhoneForSpeech(retry.normalized);
          return buildPhoneConfirmPending(
            { name: capturedName, phone: retry.normalized },
            {
              prompt: `Got it — ${capturedName} at ${formattedPhone}. Is that right?`,
              onConfirm: (c) => {
                try {
                  capturePerson({ name: c.name, phone: c.phone, relationship: c.relationship });
                  const saved = findContactByName(c.name);
                  if (!saved) {
                    return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
                  }
                  return {
                    status: 'committed',
                    ack: composeCaptureAck('phone_capture', `${c.name} at ${formatPhoneForSpeech(c.phone)}.`),
                  };
                } catch {
                  return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
                }
              },
            },
          );
        },
      },
    };
  }

  if (
    decision.actionIntent?.type === 'list_add' ||
    decision.actionIntent?.type === 'todo_add'
  ) {
    const grocerySemanticOn =
      deps.grocerySemanticDecompositionEnabled ?? GROCERY_SEMANTIC_DECOMPOSITION_ENABLED;
    if (
      grocerySemanticOn
      && decision.actionIntent.type === 'list_add'
      && (decision.actionIntent.listName ?? 'grocery').toLowerCase() !== 'todo'
      && (decision.actionIntent.listName ?? 'grocery').toLowerCase() !== 'todos'
    ) {
      const decomposed = await tryP1GrocerySemanticItems(
        text,
        deps.getMedicationSemanticInterpreterCtx ?? (() => null),
      );
      if (decomposed && decomposed.length > 0) {
        console.warn('[grocerySemanticDecomposition] ' + JSON.stringify({
          event: 'handoff_writer',
          admissionClass: 'P1',
          candidateCount: decomposed.length,
        }));
        decision.actionIntent = { ...decision.actionIntent, items: decomposed };
      }
    }
    const medEvent = detectMedicalEvent(text);
    const intents: IntentRecord[] = [];
    if (medEvent && medEvent.type === 'medication' && medEvent.tense === 'past') {
      intents.push({ type: 'medical_capture', drug: medEvent.drug_name,
                     dosage: medEvent.dosage, frequency: medEvent.frequency, raw: medEvent.raw });
    }
    intents.push(decision.actionIntent);
    return { kind: 'capture', intents, source: 'deterministic',
             reason: intents.length > 1
               ? 'tier1:list_todo_intercept+medical'
               : 'tier1:list_todo_intercept' };
  }

  // ── Natural Language Authority V1 / Slice 1: medication catalog READ ─────
  // Governing design: HERALD_NL_AUTHORITY_ARCHITECTURE_SYNTHESIS_2026-09-07.md.
  // Probabilistic bounded-capability selection (closed vocabulary, constrained
  // decode) → deterministic STRUCTURAL admission (schema + membership + risk
  // class + confidence bucket; NO medication-language evidence gate, NO
  // transcript regex) → the EXISTING authoritative SQLite medication summary
  // reader (composeMedicalSummary — the identical reader the legacy
  // 'medical:summary' tier-1 branch uses, incl. presentedMedicationIds so
  // ordinal follow-ups arm identically).
  //
  // Placement rationale:
  //  • The legacy medication READ banks (TIER1_SIGNALS.medical etc.) run inside
  //    classifyQuery and already returned a tier-1 device_read up top — they get
  //    first refusal and are frozen. Reaching here means they missed the wording.
  //  • This block runs BEFORE the Site-A personal-memory-recall decline fence
  //    below, so an unseen catalog read the model admits is ANSWERED from the
  //    authoritative reader rather than declined to a canned clarify. On any
  //    non-admit outcome it falls through and that fence (and every existing
  //    path) still applies unchanged — semantic-first, deterministic-decline
  //    fallback.
  //  • Guarded to genuine fall-through only (decision.tier === 3 &&
  //    reason === 'default'): it never runs for a tier-1 deterministic claim, so
  //    it CANNOT reinterpret a floor-claimed medication capture (handled just
  //    below at the medical_capture intercept), a device action, or a world-data
  //    'live:data' query as a read. The deterministic floor always wins.
  //
  // Read-only and isolated from the write path: this block constructs ONLY a
  // device_read RouteDecision. It never builds an IntentRecord, never calls a
  // DOMAIN_WRITER, never arms a pending, never mutates. Reuses the SAME
  // independent medication 3B context as the write seam
  // (deps.getMedicationSemanticInterpreterCtx); adds no new context. Law 0 and
  // pending ownership are enforced upstream in processUtterance before
  // routeIntent is called, so this block cannot see, preempt, or race either.
  const grocerySemanticOn =
    deps.grocerySemanticDecompositionEnabled ?? GROCERY_SEMANTIC_DECOMPOSITION_ENABLED;
  const dispatchOn =
    deps.semanticCapabilityDispatchEnabled ?? SEMANTIC_CAPABILITY_DISPATCH_ENABLED;
  const capabilityReadOn =
    deps.capabilityReadRouterEnabled ?? CAPABILITY_READ_ROUTER_ENABLED;
  const medicationSemanticOn =
    deps.medicationSemanticInterpretationEnabled ?? MEDICATION_SEMANTIC_INTERPRETATION_ENABLED;
  const multiFactOn =
    deps.naturalMultiFactInterpretationEnabled ?? NATURAL_MULTI_FACT_INTERPRETATION_ENABLED;
  const tryMultiFact = (intercept: 'visit' | 'fallthrough') => {
    const hold = tryNaturalMultiFactHold(text, {
      enabled: multiFactOn,
      propose: deps.proposeNaturalMultiFact,
      intercept,
    });
    if (!hold) return null;
    return {
      kind: 'interpretation_hold' as const,
      reason: 'natural_multi_fact_v1' as const,
      episodeId: hold.episodeId,
      candidates: hold.candidates,
    };
  };
  const getSemanticCtx = deps.getMedicationSemanticInterpreterCtx ?? (() => null);
  const eligibleDefaultFallthrough = decision.tier === 3 && decision.reason === 'default';
  let dispatchSeamRan = false;
  let dispatchSelected: CapabilityId | null = null;
  let dispatchProposal: CapabilityProposal | null = null;

  if (eligibleDefaultFallthrough && dispatchOn) {
    dispatchSeamRan = true;
    const eligibility = evaluateSemanticDispatchEligibility(text);
    logSemanticDispatchEligibility({
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      tier: decision.tier,
      routeReason: decision.reason,
    });
    if (eligibility.eligible) {
      const capGen = await generateCapabilityProposal(text, getSemanticCtx);
      if (capGen.status === 'ok') {
      dispatchSelected = capGen.proposal.capability;
      dispatchProposal = capGen.proposal;
      dispatchDiag = {
        invoked: true,
        generationStatus: 'ok',
        unavailableReason: null,
        proposedCapability: capGen.proposal.capability,
        selectedCapability: capGen.proposal.capability,
        specialistInvoked: 'none',
        specialistResult: 'not_run',
      };
      if (dispatchSelected === WIRED_READ_CAPABILITY && capabilityReadOn) {
        const readDecision = await admitWiredMedicationRead(capGen.proposal);
        if (readDecision) {
          dispatchDiag.finalOutcome = readDecision.reason === 'personal_memory:recall_declined'
            ? 'recall_declined'
            : 'read_admit';
          return readDecision;
        }
      }
      if (
        dispatchSelected === 'list.read'
        && CAPABILITY_RISK_CLASS['list.read'] === 'read'
        && capGen.proposal.confidence !== 'low'
      ) {
        const { getPresentedOpenListItems, composeOpenListSpeech } = await import('../db/listRead');
        const listName = 'grocery';
        const items = getPresentedOpenListItems(listName);
        dispatchDiag.finalOutcome = 'read_admit';
        return {
          kind: 'device_read',
          tier: 1,
          response: composeOpenListSpeech(listName, items),
          reason: 'action:list_read',
          presentedGroceryIds: items.map((i) => i.id),
        };
      }
      if (
        dispatchSelected === 'todo.read'
        && CAPABILITY_RISK_CLASS['todo.read'] === 'read'
        && capGen.proposal.confidence !== 'low'
      ) {
        const { getPresentedOpenListItems, composeTodoOpenSpeech } = await import('../db/listRead');
        const items = getPresentedOpenListItems('todos');
        dispatchDiag.finalOutcome = 'read_admit';
        return {
          kind: 'device_read',
          tier: 1,
          response: composeTodoOpenSpeech(items),
          reason: 'action:todo_read',
          presentedTodoIds: items.map((i) => i.id),
        };
      }
    } else if (capGen.status === 'parse_fail') {
      dispatchDiag = {
        invoked: true,
        generationStatus: 'parse_fail',
        unavailableReason: null,
        proposedCapability: null,
        selectedCapability: null,
        specialistInvoked: 'none',
        specialistResult: 'not_run',
      };
    } else {
      dispatchDiag = {
        invoked: true,
        generationStatus: 'unavailable',
        unavailableReason: capGen.reason,
        proposedCapability: null,
        selectedCapability: null,
        specialistInvoked: 'none',
        specialistResult: 'not_run',
      };
    }
      // Grocery/Todo capability-ownership repair (Conversation Reliability V1,
      // Lane B). Eligibility already marked this turn grocery/todo-correlated
      // before the model ran; a transport-level failure to answer
      // (parse_fail/unavailable/error) must not silently drop that ownership
      // into generic conversation. Every function reused below is existing
      // and already tested -- no new regex, no new capability, no widened
      // authority. A completed model REJECT/CLARIFY (capGen.status === 'ok')
      // never reaches this block.
      if (capGen.status !== 'ok') {
        // 'instruction' included alongside the grocery/todo-correlated
        // reasons: isExplicitInstructionToHerald (speechActAuthority.ts)
        // checks TODO_ADD_PREFIX itself and is evaluated before
        // evaluateSemanticDispatchEligibility ever reaches its own
        // TODO_ADD_PREFIX/TODO_ADD_SIGNALS check -- so any utterance shaped
        // to satisfy extractTodoAdd's own prefix requirement below is
        // eligibility-classified 'instruction', never 'todo_obligation'.
        // Confirmed via regression (test 2,
        // groceryTodoCapabilityOwnershipRecovery.test.ts). Still safely
        // bounded: 'instruction' also covers alarms/reminders/notes, but
        // this block only ever activates when parseOperationalDomainResolution
        // AND extractNarrativeOperationalCandidates/extractNarrativeTodoAdd
        // independently succeed too -- those, not this reason set, are the
        // real gate. extractNarrativeTodoAdd (Conversation Reliability V1,
        // sentence-segmentation pass) tries the whole message first
        // (unchanged behavior), then each sentence independently, so a
        // narrative preamble cannot hide an embedded obligation sentence --
        // but domain resolution below still requires an explicit "to-do"/
        // "task" marker word, which the class example this repair targets
        // does not always contain; see naturalObligationCallGuard follow-up
        // notes for the acceptance-example-specific residual gap.
        const recoveryEligibleReasons = new Set([
          'list_add', 'todo_obligation', 'acquisition', 'obligation_family', 'bare_need', 'grocery_context', 'instruction',
        ]);
        if (recoveryEligibleReasons.has(eligibility.reason)) {
          const domain = parseOperationalDomainResolution(text);
          const groceryItems = extractNarrativeOperationalCandidates(text);
          const todoExtraction = extractNarrativeTodoAdd(text);
          const todoBody = todoExtraction?.kind === 'add' ? todoExtraction.body : null;
          if (domain === 'grocery' && groceryItems) {
            if (dispatchDiag) dispatchDiag.finalOutcome = 'specialist_admit';
            // Multi-Candidate V1 (Conversation Reliability), Stage 2: this
            // recovery path already resolved one candidate (grocery); a
            // second, independent candidate (todo) may still exist in a
            // different sentence of the same compound utterance.
            // extractNarrativeTodoAdd applies the identical admission
            // standard a lone todo utterance would get -- no lowered bar,
            // no new vocabulary. Both candidates share this turn's single
            // 'deterministic_recovery' source, so both go through Build C's
            // existing confirm gate; Multi-Candidate V1 Stage 1 preserves
            // the second candidate's confirmation instead of losing it.
            const residualTodo = extractNarrativeTodoAdd(text);
            const intents: IntentRecord[] = [{ type: 'list_add', items: groceryItems, listName: 'grocery' }];
            if (residualTodo?.kind === 'add' && residualTodo.body.length > 2) {
              intents.push({ type: 'todo_add', body: residualTodo.body });
            }
            return {
              kind: 'capture',
              intents,
              source: 'deterministic_recovery',
              reason: 'semantic_proposal:grocery_recovery',
            };
          }
          if (domain === 'todo' && todoBody) {
            if (dispatchDiag) dispatchDiag.finalOutcome = 'specialist_admit';
            // Multi-Candidate V1 (Conversation Reliability), Stage 2: same
            // reasoning as the grocery branch above, mirrored -- a second,
            // independent grocery candidate may exist in another sentence.
            // Reuses extractNarrativeOperationalCandidates per sentence,
            // the SAME function/standard the grocery branch itself uses.
            const sentences = splitNarrativeSentences(text);
            let residualGrocery: string[] | null = null;
            for (const sentence of sentences) {
              // Same third-party exclusion as the tier-1 mirror of this
              // scan (tierRouter.ts) -- see that call site's comment.
              if (utteranceHasThirdPartyFiniteAction(sentence)) continue;
              const items = extractNarrativeOperationalCandidates(sentence);
              if (items) { residualGrocery = items; break; }
            }
            const intents: IntentRecord[] = [{ type: 'todo_add', body: todoBody }];
            if (residualGrocery) {
              intents.push({ type: 'list_add', items: residualGrocery, listName: 'grocery' });
            }
            return {
              kind: 'capture',
              intents,
              source: 'deterministic_recovery',
              reason: 'semantic_proposal:todo_recovery',
            };
          }
          if (domain === 'grocery' || domain === 'todo') {
            return {
              kind: 'needs_clarification',
              reason: domain === 'grocery'
                ? 'semantic_proposal:grocery_recovery_empty'
                : 'semantic_proposal:todo_recovery_empty',
            };
          }
          // Domain-unresolved-but-items-extracted (e.g. "we need bread, eggs,
          // and bananas") is deliberately NOT intercepted here. Verified live:
          // discourseContinuity.ts's noteNarrativeUtterance() already runs
          // unconditionally earlier in this same turn (before routeIntent is
          // even called) and independently establishes/refreshes the
          // candidateSet from the identical extractNarrativeOperationalCandidates
          // call. Returning an ambiguous_operational_list RouteDecision here
          // too would additionally re-arm processUtterance.ts's own
          // operational_list_ambiguity pending on every repeated occurrence
          // (confirmed via regression: WCS B2/B4/C1 in
          // conversationFoundationSmoothMvp.test.ts), corrupting later turns.
          // Reconciling the two mechanisms is WCS candidate-continuity work,
          // out of bounds tonight -- left as a follow-up, not silently patched.
          // No bounded extraction possible, or domain-unresolved -- fall
          // through unchanged to today's generic conversational fallback.
        }
      }
    }
  } else if (capabilityReadOn && eligibleDefaultFallthrough) {
    const capGen = await generateCapabilityProposal(text, getSemanticCtx);
    if (capGen.status === 'ok') {
      const admission = admitCapabilityProposal(capGen.proposal);
      if (admission.decision === 'ADMIT_READ') {
        const { composeMedicalSummary } = await import('../db/medicalDB');
        const summary = composeMedicalSummary();
        return {
          kind: 'device_read',
          tier: 1,
          response: summary.response,
          isMedical: true,
          reason: 'medical:summary',
          presentedMedicationIds: summary.medicationIds,
        };
      }
      if (capGen.proposal.capability === WIRED_READ_CAPABILITY) {
        return { kind: 'needs_clarification', reason: 'personal_memory:recall_declined' };
      }
    }
  }

  // Site-A fence (early): recall-shaped questions must fail closed before a
  // mis-tiered medical_capture intercept can resurrect them as a write.
  // Tier-1 device_read paths above already returned; this catches tier-3
  // fallthrough and medical_capture misfires (e.g. "Did you say the doctor…").
  if (isPersonalMemoryRecallQuestion(text)) {
    if (isHeraldSelfReferentConversationalShape(text)) {
      if (dispatchDiag && dispatchDiag.finalOutcome == null) {
        dispatchDiag.finalOutcome = 'fallback';
      }
      return { kind: 'needs_clarification', reason: 'default' };
    }
    if (dispatchDiag && dispatchDiag.finalOutcome == null) {
      dispatchDiag.finalOutcome = 'recall_declined';
    }
    return { kind: 'needs_clarification', reason: 'personal_memory:recall_declined' };
  }

  if (
    decision.tier === 1 &&
    decision.actionIntent?.type === 'medical_capture' &&
    decision.actionIntent.event
  ) {
    const ev = decision.actionIntent.event;
    if (ev.type === 'medication') {
      return {
        kind: 'capture',
        intents: [{ type: 'medical_capture', drug: ev.drug_name, dosage: ev.dosage, frequency: ev.frequency, raw: ev.raw }],
        source: 'deterministic',
        reason: 'tier1:medication_intercept',
      };
    }
    if (ev.type === 'visit' && ev.tense === 'future') {
      return {
        kind: 'capture',
        intents: [{ type: 'medical_visit_upcoming', doctor_name: ev.doctor_name, specialty: ev.specialty, raw: ev.raw }],
        source: 'deterministic',
        reason: 'tier1:visit_upcoming_intercept',
      };
    }
    const visitHold = tryMultiFact('visit');
    if (visitHold) return visitHold;
    // visit | advice → medical_visit (heard "Dr. X" still confirms; nameless asks who).
    return {
      kind: 'capture',
      intents: [{ type: 'medical_visit', doctor_name: ev.doctor_name, specialty: ev.specialty, advice: ev.advice, raw: ev.raw }],
      source: 'deterministic',
      reason: 'tier1:visit_intercept',
    };
  }

  // ── Medication Semantic Interpretation V1 seam ──────────────────────────
  // Governing docs: HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1_IMPLEMENTATION_DESIGN.md,
  // HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1_CTO_REVIEW_RESOLUTION.md.
  // Placement: AFTER every deterministic capturer/floor mechanism above —
  // including detectMedicalEvent/hasMedicationDomainEvidence via the tier-1
  // medical_capture intercept immediately above, and every capturer in
  // CAPTURERS_WITH_PHONE earlier in this function — has already had first
  // refusal, and BEFORE the generic classifyLLM tier-3 capture path below.
  // Does not move existing routing precedence. Law 0 (emergency) and pending
  // ownership are checked upstream in processUtterance, before routeIntent is
  // ever called (processUtterance.ts) — this block cannot see, preempt, or
  // race either; ctx.hasPending is passed as false here only as the required
  // defensive re-check inside admitMedicationSemanticProposal itself (that
  // function DEFERs unconditionally if it were ever true).
  //
  // The interpreter proposes meaning only. Admission is a pure, deterministic
  // function (medicationSemanticInterpretation.ts). On ADMIT this constructs
  // nothing but the pre-existing 'medical_capture' IntentRecord using only
  // provenance-verified values and the original raw utterance, tagged
  // source:'llm' so it travels through the existing generic confirm gate
  // (applyIntents, processUtterance.ts) and DOMAIN_WRITERS.medical_capture's
  // own confirm gate, unmodified — no new writer, DB path, table, pending
  // primitive, or IntentRecord variant is created.
  if (dispatchSeamRan) {
    if (dispatchSelected === 'medication.capture' && medicationSemanticOn) {
      if (dispatchDiag) {
        dispatchDiag.specialistInvoked = 'medication';
        dispatchDiag.specialistResult = 'no_admit';
      }
      const pre = dispatchProposal
        ? medicationSemanticProposalFromDispatchWrite(dispatchProposal)
        : null;
      const medDecision = pre ? medicationSemanticCaptureDecision(text, pre) : null;
      if (medDecision) {
        if (dispatchDiag) {
          dispatchDiag.specialistResult = 'admit';
          dispatchDiag.finalOutcome = 'specialist_admit';
        }
        return medDecision;
      }
    } else if (dispatchSelected === 'grocery.capture' && grocerySemanticOn) {
      if (dispatchDiag) {
        dispatchDiag.specialistInvoked = 'grocery';
        dispatchDiag.specialistResult = 'no_admit';
      }
      const pre = dispatchProposal
        ? grocerySemanticProposalFromDispatchWrite(dispatchProposal)
        : null;
      const groceryDecision = pre ? grocerySemanticP2Decision(text, pre) : null;
      if (groceryDecision) {
        if (dispatchDiag) {
          dispatchDiag.specialistResult = 'admit';
          dispatchDiag.finalOutcome = 'specialist_admit';
        }
        return groceryDecision;
      }
    } else if (dispatchSelected === 'todo.capture') {
      if (dispatchDiag) {
        dispatchDiag.specialistInvoked = 'todo';
        dispatchDiag.specialistResult = 'no_admit';
      }
      const pre = dispatchProposal
        ? todoSemanticProposalFromDispatchWrite(dispatchProposal)
        : null;
      const todoDecision = pre ? todoSemanticP2Decision(text, pre) : null;
      if (todoDecision?.kind === 'capture') {
        if (dispatchDiag) {
          dispatchDiag.specialistResult = 'admit';
          dispatchDiag.finalOutcome = 'specialist_admit';
        }
        return todoDecision;
      }
      if (todoDecision) {
        return todoDecision;
      }
    }
  } else {
    // Serial medication probe is dispatch-OFF fallback only: same 3/default
    // ownership as grocery P2 in this branch. live:data and other non-default
    // owners must not pay a medication specialist completion.
    if (
      medicationSemanticOn
      && decision.tier === 3
      && decision.reason === 'default'
    ) {
      const medDecision = await tryMedicationSemanticCaptureRoute(text, getSemanticCtx);
      if (medDecision) return medDecision;
    } else if (medicationSemanticOn) {
      logSemanticMedicationSerialSkip({
        reason: 'non_default_route',
        tier: decision.tier,
        routeReason: decision.reason,
      });
    }
    if (
      grocerySemanticOn
      && decision.tier === 3
      && decision.reason === 'default'
    ) {
      const groceryDecision = await tryGrocerySemanticP2Route(text, getSemanticCtx);
      if (groceryDecision) return groceryDecision;
    }
  }

  // LAT-ARC-B: tracks whether a REAL classifyLLM completion happened for
  // this utterance (never set for a not_ready/never-attempted classifier).
  // Carried only onto the 'backend' return below — 'capture'/source:'llm'
  // already carries an equally explicit, pre-existing signal (source) and
  // needs no new field. Read by ChatScreen to skip a redundant
  // re-classification of the identical utterance (proven duplicate paths:
  // 'backend'/live:data, and 'capture' source:'llm' with an unconverted
  // intent type — see session investigation, 2026-08-18).
  let llmAlreadyClassified = false;
  let readMeta: ReadIntentMeta | undefined;

  const fallthroughHold = tryMultiFact('fallthrough');
  if (fallthroughHold) return fallthroughHold;

  if (deps.llmReady && deps.classifyLLM) {
    const out = await deps.classifyLLM(text);
    // A-3: classify may run here; read dispatch is deferred to ChatScreen after
    // remaining deterministic nets miss. readMeta travels on the RouteDecision.
    if (out.status === 'ok') {
      if (out.readLabeled || (out.readIntents?.length ?? 0) > 0) {
        readMeta = {
          readIntents: out.readIntents ?? [],
          readLabeled: out.readLabeled ?? false,
        };
      }
    }
    // A busy or absent classifier is NOT "found nothing" — it never ran. Returning
    // [] here would fall through to the backend and ship the user's raw words to
    // Railway because of a concurrency state, not because the utterance needed the
    // network. not_ready is a distinct route: honest tail, no network.
    if (out.status === 'not_ready') {
      if (decision.reason === 'ambiguous_operational_list') {
        return {
          kind: 'needs_clarification',
          reason: 'ambiguous_operational_list',
          guess: extractAmbiguousAcquisitionObject(text) ?? undefined,
        };
      }
      return { kind: 'not_ready', reason: `llm:not_ready:${out.reason}` };
    }
    if (out.status === 'failed') {
      if (decision.reason === 'ambiguous_operational_list') {
        return {
          kind: 'needs_clarification',
          reason: 'ambiguous_operational_list',
          guess: extractAmbiguousAcquisitionObject(text) ?? undefined,
        };
      }
      // Warmup uses failed; real classify degrades to ok/[]. Defensive.
      return { kind: 'needs_clarification', reason: 'llm:failed' };
    }
    llmAlreadyClassified = true;
    // 'pass' is the classifier's own honest "unclear / none of the above"
    // signal (llmLayers.ts prompt: "When genuinely unclear → pass"). It is
    // NOT a capture instruction and has no DOMAIN_WRITERS entry — letting it
    // through here made needs_clarification unreachable for these utterances
    // and routed them into dispatchLocalIntent's generic default case instead.
    // Filtering it here restores the honest tail (needs_clarification) and
    // — because processUtterance's allConverted gate then never needs to run
    // ChatScreen's second classifyWithLLM call for this utterance — also
    // removes one redundant on-device inference per unmatched turn.
    const llmResult = (
      await mapCallIntents(out.intents, text, deps)
    ).filter(i => i.type !== 'pass');
    // CONV-C1: narration must not acquire capture authority from structural validity alone.
    // Medication bypass closure (CTO review resolution, §1): classifyLLM may
    // self-extract a drug name directly from free text for 'medical_capture'
    // (llmLayers.ts prompt) with no medication-domain-evidence check of its
    // own — shouldRefuseLlmCaptureProposal's D1/D3/D4/D5 test address/tense
    // only. Medication-only, additive: reuses hasMedicationDomainEvidence
    // completely unmodified, at this sole llm-capture conversion site. A
    // failing check falls through unchanged to the existing
    // needs_clarification tail below, exactly as an empty classifier result
    // already does today — no new state, whole batch declines together
    // (same all-or-nothing precedent processUtterance's allConverted gate
    // already applies to this exact array).
    if (
      llmResult.length > 0 &&
      !shouldRefuseLlmCaptureProposal(text, llmResult) &&
      !llmMedicationCaptureLacksEvidence(text, llmResult)
    ) {
      return {
        kind: 'capture',
        intents: llmResult,
        source: 'llm',
        reason: decision.reason === 'ambiguous_operational_list'
          ? 'llm:capture:ambiguous_operational_list'
          : 'llm:capture',
      };
    }
  }

  if (decision.reason === 'live:data') {
    return { kind: 'backend', tier: 3, reason: decision.reason, llmAlreadyClassified, readMeta };
  }
  // Deferred-ready window: local LLM is loading/warming. Do not misattribute
  // as needs_clarification ("I'm not sure I'm following you"). live:data above
  // still reaches the network without the on-device classifier.
  if (!deps.llmReady && deps.llmStatus === 'loading' && decision.reason !== 'ambiguous_operational_list') {
    return { kind: 'not_ready', reason: 'llm:not_ready:loading' };
  }
  return {
    kind: 'needs_clarification',
    reason: decision.reason,
    guess: decision.reason === 'ambiguous_operational_list'
      ? extractAmbiguousAcquisitionObject(text) ?? undefined
      : undefined,
    readMeta,
  };
  } finally {
    if (dispatchDiag) {
      logSemanticDispatchDiag({
        ...dispatchDiag,
        finalOutcome: dispatchDiag.finalOutcome ?? 'fallback',
      });
    }
    latLog('routeIntent END', {
      turnId,
      durationMs: Math.round((latMono() - routeT0) * 100) / 100,
    });
  }
}
