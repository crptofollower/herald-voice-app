import { routeIntent, DOMAIN_WRITERS, composeAck, allConverted } from './routeIntent';
import type { RouteDecision, CommitResult, ResolveContactFn, DomainFocusEnvelope } from './routeIntent';
import type { IntentRecord } from '../hooks/llmLayers';
import type { ConversationTurnLedger } from './conversationTurnLedger';
import { commitResultOutcome, captureAuthorityTier, buildFocusEntry } from './conversationTurnLedgerWrite';
import { ConversationSession, CONFIRM_YES_RE, CONFIRM_NO_RE } from './conversationSession';
import { CALL_TEXT_RECOVERY_KEY, shouldPreemptCallTextRecovery } from './callTextReadiness';
import { detectEmergency } from './emergencySignals';
import {
  ConversationalSubjectHolder,
  isReferentPhoneQuestion,
  answerReferentPhone,
  isReferentVisitDateQuestion,
  answerReferentVisitDate,
  isReferentVisitOutcomeQuestion,
  answerReferentVisitOutcome,
  isReferentUpcomingVisitQuestion,
  answerReferentUpcomingVisit,
  isReferentYearBoundedVisitQuestion,
  answerReferentYearBoundedVisit,
} from './conversationalSubject';
import { detectFamilyRead, resolveFamilyRead } from '../utils/familyRead';
import { resolveHouseholdProvider } from '../utils/householdRead';
import { getLastVisit } from '../db/medicalDB';
import { extractDoctorName } from '../utils/detectMedicalEvent';
import { getActiveTurnId, log as latLog } from '../utils/latencyInstrument';
import {
  CONTINUATION_RECOVERY_SAFE_LABEL,
  recordContinuationRecoveryCandidate,
  type ContinuationRecoveryCandidate,
} from '../conversation/continuationRecovery';
import {
  MedicationPresentationHolder,
  answerMedicationOrdinal,
  isMedicationOrdinalNearMiss,
  parseMedicationOrdinalIndex,
  MEDICATION_ORDINAL_CONFUSION,
} from './medicationPresentation';
import {
  OrderedPresentationHolder,
  resolvePositions,
  ORDERED_PRESENTATION_CONFUSION,
  GROCERY_POSITION_STALE,
} from './orderedPresentation';
import {
  getOpenListItemById,
  getPresentedOpenListItems,
  composeOpenListSpeech,
  formatGroceryItemReadback,
  markOpenListItemRemovedById,
} from '../db/listRead';
import { parseGroceryNamedCollectionRead } from './groceryNamedCollectionReentry';
import { interpretPositionReference, isPositionMutationLanguage, hasBoundedPositionEvidence } from './positionReference';
import {
  parseGroceryPositionalMutation,
  hasGroceryNamedMutationCue,
  formatGroceryRemovalAck,
  isGroceryMutationDomainBlocked,
} from './groceryPositionalMutation';
import {
  CalendarContinuationHolder,
  parseCalendarTemporalFollowUp,
} from './calendarContinuation';
import {
  CalendarPresentationHolder,
  parseCalendarTimeInquiry,
  answerCalendarTimeInquiry,
} from './calendarPresentation';
import { hasCalendarReadEvidence, readCalendarScope } from './tierRouter';
import { DiscourseContinuityHolder } from './discourseContinuity';
import {
  extractAmbiguousAcquisitionObject,
  formatOperationalListClarification,
  interpretCandidateSetDemonstrative,
  isAddShapedOperationalDemonstrative,
  isOperationalListItemShape,
  parseOperationalDomainResolution,
  parseOperationalListContinuationAdd,
  splitCapturedTailSegments,
} from './operationalListContinuity';

// D0 commit 2 (S54 addendum): the headless pipeline seam. UI (ChatScreen) calls
// this and renders the result; P-tests call it directly. No React, no UI, no TTS.
// S-DISCLOSE build arc step 2 (S-CONFIRM absorbed into this arc, per state doc):
// pending resolution now runs through ConversationSession.resolvePending — the
// confirm-primitive (Gap 4). take-then-clear + fallthrough-on-noop is retired;
// a pending state never leaks to fresh routing (Law 2, Spine §3a).
// LLM_LIVE Build C (P5): source-gated confirm — llm-sourced captures arm a
// generic confirm pending before any DOMAIN_WRITER.add; deterministic unchanged.

export type RouteDeps = Parameters<typeof routeIntent>[1];

export type UtteranceOutcome =
  | { handled: true; source: 'pending_resume' | 'capture' | 'referent_resume'; responseText: string; commits: CommitResult[] }
  | { handled: true; source: 'emergency' }
  | {
      handled: false;
      routeDecision: RouteDecision;
      continuationRecoveryCandidates: ContinuationRecoveryCandidate[];
      /** Orchestration publishes this on the turn's existing ledger write. */
      continuityFocus?: DomainFocusEnvelope;
      continuityReferenceOnly?: boolean;
    };

/** Narrative reference-only focus is admitted only on the conversational
 *  path (needs_clarification / backend without a classified read). A
 *  successful device_read, device_action, or other domain operation may
 *  contain a title-case name; that name is not conversational subject
 *  merely because WCS extracted it. Doctor visit-history uses its own
 *  Flow C + reason gate, not this helper. */
function admitsNarrativeContinuityPublication(routeDecision: RouteDecision): boolean {
  if (routeDecision.kind === 'needs_clarification') {
    if (routeDecision.reason === 'ambiguous_operational_list') return false;
    if (routeDecision.readMeta) return false;
    return true;
  }
  if (routeDecision.kind === 'backend' && !routeDecision.readMeta) return true;
  return false;
}

function maybeEstablishConversationalSubject(
  text: string,
  routeDecision: RouteDecision,
  holder: ConversationalSubjectHolder,
): boolean {
  if (routeDecision.kind === 'device_read' && routeDecision.reason === 'family:read') {
    const intent = detectFamilyRead(text);
    if (!intent) return false;
    const match = resolveFamilyRead(intent);
    if (match) {
      holder.establishFamily(match);
      return true;
    }
    return false;
  }
  if (
    routeDecision.kind === 'device_action' &&
    routeDecision.actionIntent.type === 'household_read' &&
    routeDecision.actionIntent.intent.type === 'service_provider'
  ) {
    const match = resolveHouseholdProvider(routeDecision.actionIntent.intent);
    if (match) {
      holder.establishHousehold(match);
      return true;
    }
    return false;
  }
  // Continuity Step 3: a completed deterministic most-recent-visit read that
  // identified exactly one doctor establishes that doctor as the subject.
  // Re-derives identity from the same deterministic reader the branch used —
  // it does not trust the response string. No name ⇒ no subject (fail closed).
  if (routeDecision.kind === 'device_read' && routeDecision.reason === 'medical:visit_history_read') {
    const visit = getLastVisit(extractDoctorName(text));
    const name = visit?.doctorName?.trim();
    if (name) {
      holder.establishMedical({ entityId: name, displayName: name });
      return true;
    }
  }
  return false;
}

function maybeEstablishMedicationPresentation(
  routeDecision: RouteDecision,
  holder: MedicationPresentationHolder,
  subject: ConversationalSubjectHolder | null,
  orderedPresentation?: OrderedPresentationHolder | null,
  calendarPresentation?: CalendarPresentationHolder | null,
): void {
  if (routeDecision.kind !== 'device_read' || routeDecision.reason !== 'medical:summary') {
    return;
  }
  const ids = routeDecision.presentedMedicationIds ?? [];
  if (ids.length === 0) {
    holder.clear();
    return;
  }
  // A live person-subject must not compete with medication ordinals.
  subject?.clear();
  orderedPresentation?.clear();
  calendarPresentation?.clear();
  holder.establish(ids);
}

function maybeEstablishGroceryPresentation(
  routeDecision: RouteDecision,
  holder: OrderedPresentationHolder | null | undefined,
  subject: ConversationalSubjectHolder | null,
  medicationPresentation: MedicationPresentationHolder | null | undefined,
  calendarPresentation?: CalendarPresentationHolder | null,
): void {
  if (routeDecision.kind !== 'device_read' || routeDecision.presentedGroceryIds === undefined) {
    return;
  }
  const ids = routeDecision.presentedGroceryIds;
  if (ids.length === 0) {
    holder?.clear();
    return;
  }
  subject?.clear();
  medicationPresentation?.clear();
  calendarPresentation?.clear();
  holder?.establish('grocery', ids);
}

function maybeEstablishCalendarContinuation(
  routeDecision: RouteDecision,
  holder: CalendarContinuationHolder | null | undefined,
): void {
  if (!holder) return;
  if (routeDecision.kind !== 'device_read') return;
  if (!routeDecision.reason.startsWith('calendar:')) return;
  holder.establish(routeDecision.reason);
}

function maybeEstablishCalendarPresentation(
  routeDecision: RouteDecision,
  holder: CalendarPresentationHolder | null | undefined,
  subject: ConversationalSubjectHolder | null,
  medicationPresentation: MedicationPresentationHolder | null | undefined,
  orderedPresentation: OrderedPresentationHolder | null | undefined,
): void {
  if (!holder) return;
  if (routeDecision.kind !== 'device_read') return;
  if (!routeDecision.reason.startsWith('calendar:')) return;
  if (routeDecision.presentedCalendarEventIds === undefined) return;
  const ids = routeDecision.presentedCalendarEventIds;
  if (ids.length === 0) {
    holder.clear();
    return;
  }
  subject?.clear();
  medicationPresentation?.clear();
  orderedPresentation?.clear();
  holder.establish(ids);
}

/** The single commit loop: run intents through domain writers, arm the session
 *  if a writer returned pending. Returns the composed ACK and raw results.
 *  `source` is required — the RouteDecision's capture source for this whole
 *  batch (one decision → one shared source). Callers must pass it explicitly;
 *  there is no default (omitting it used to silently skip the Build C gate). */
export async function applyIntents(
  intents: IntentRecord[],
  rawText: string,
  session: ConversationSession,
  ctx: { resolveContact?: ResolveContactFn } | undefined,
  source: 'deterministic' | 'llm',
  llmGate?: { declineAck?: string; domainConfirmOwnsCapture?: boolean },
  ledger?: ConversationTurnLedger | null,
): Promise<{ responseText: string; commits: CommitResult[] }> {
  const results: CommitResult[] = [];
  for (const intent of intents) {
    const writer = DOMAIN_WRITERS[intent.type];
    if (!writer) continue;
    if (source === 'llm' && !llmGate?.domainConfirmOwnsCapture) {
      // Build C: do not call writer.add until the user confirms.
      const queuedPending = {
        status: 'pending' as const,
        prompt: "Say yes and I'll remember that.",
        pendingKey: `llm_confirm:${intent.type}`,
        resume: async (userText: string): Promise<CommitResult> => {
          // No ledger push in this closure: it runs later, as the resumed
          // pending, via processUtterance's `session.resolvePending(text)`
          // call site below (Hook 2), which pushes exactly once per resume
          // regardless of which pending-construction site created the
          // closure. Pushing here too would double-count this turn.
          const trimmed = userText.trim();
          if (CONFIRM_NO_RE.test(trimmed)) {
            return { status: 'noop', ack: llmGate?.declineAck ?? "No problem — I won't remember that." };
          }
          if (CONFIRM_YES_RE.test(trimmed)) {
            return writer.add(intent, rawText, ctx);
          }
          return { status: 'noop', ack: '' };
        },
      };
      // No domain envelope available here: Build C withholds writer.add()
      // until confirmed, so no domain code has run yet at this exact point
      // — buildFocusEntry(undefined, ...) legally yields []. Semantic Focus
      // Contract V1 does not change this gate's existing behavior.
      ledger?.push({
        establishedAt: Date.now(),
        utterance: rawText,
        intentType: intent.type,
        operation: 'capture',
        outcome: commitResultOutcome(queuedPending.status),
        authorityTier: captureAuthorityTier(source),
        assistantReplySummary: queuedPending.prompt,
        focus: buildFocusEntry(undefined, { status: queuedPending.status, source }),
      });
      results.push(queuedPending);
      continue;
    }
    const added = await writer.add(intent, rawText, ctx);
    ledger?.push({
      establishedAt: Date.now(),
      utterance: rawText,
      intentType: intent.type,
      operation: 'capture',
      outcome: commitResultOutcome(added.status),
      authorityTier: captureAuthorityTier(source),
      assistantReplySummary: added.status === 'committed' || added.status === 'noop' || added.status === 'failed' ? added.ack : null,
      focus: buildFocusEntry(added.focus, { status: added.status, source }),
    });
    results.push(added);
  }
  const responseText = composeAck(results);
  const pending = results.find(r => r.status === 'pending');
  if (pending && pending.status === 'pending') {
    session.setPending({
      pendingKey: pending.pendingKey,
      resume: pending.resume,
      kind: pending.kind,
      reaskPrompt: pending.reaskPrompt,
      releasePrompt: pending.releasePrompt,
      budget: pending.budget,
      correctable: pending.correctable,
    });
  }
  return { responseText, commits: results };
}

export async function processUtterance(
  text: string,
  session: ConversationSession,
  deps: RouteDeps,
  subject?: ConversationalSubjectHolder | null,
  medicationPresentation?: MedicationPresentationHolder | null,
  orderedPresentation?: OrderedPresentationHolder | null,
  calendarPresentation?: CalendarPresentationHolder | null,
  calendarContinuation?: CalendarContinuationHolder | null,
  discourse?: DiscourseContinuityHolder | null,
  ledger?: ConversationTurnLedger | null,
): Promise<UtteranceOutcome> {
  const turnId = getActiveTurnId();
  latLog('processUtterance START', { turnId });
  subject?.beginUserTurn();
  medicationPresentation?.beginUserTurn();
  orderedPresentation?.beginUserTurn();
  calendarPresentation?.beginUserTurn();
  calendarContinuation?.beginUserTurn();
  discourse?.beginUserTurn();
  const continuationRecoveryCandidates: ContinuationRecoveryCandidate[] = [];
  // 0) Law 0 — emergency preempts everything (Spine §3a). Checked before pending
  //    resolution, before routing, before any classifier. A held pending is
  //    RELEASED, never resumed — no re-ask, no ladder, no ack generated here
  //    (ChatScreen speaks the actual emergency reply). No route decision is
  //    ever computed for an emergency utterance.
  if (detectEmergency(text)) {
    if (session.hasPending()) session.clearPending();
    subject?.clear();
    medicationPresentation?.clear();
    orderedPresentation?.clear();
    calendarPresentation?.clear();
    calendarContinuation?.clear();
    discourse?.clear();
    return { handled: true, source: 'emergency' };
  }
  // 1) Pending continuation — the confirm-primitive (Law 2: a pending state
  //    never leaks). resolvePending owns cancel-escape, the domain resume,
  //    the re-ask ladder, and release — it never falls through to fresh
  //    routing. Every call returns a terminal result for this turn.
  //    PendingSlot is ABSOLUTE vs Flow C: do not evaluate the referent
  //    speech-act or re-read by id while a pending owns the turn.
  //
  //    Bounded exception (Call/Text recovery slice): a pending clarification
  //    yields when existing routing already claims the utterance (device
  //    action, device read, or live-data) and the text is not a plausible
  //    pending answer. Not a capability allowlist.
  if (session.hasPending()) {
    const recoveryPending = session.peekPendingKey() === CALL_TEXT_RECOVERY_KEY;
    if (recoveryPending) {
      const decision = await deps.classifyQuery(text);
      if (shouldPreemptCallTextRecovery(decision, text, session.pendingOwnsReply(text))) {
        session.clearPending();
      }
    }
  }
  if (session.hasPending()) {
    subject?.clear();
    medicationPresentation?.clear();
    orderedPresentation?.clear();
    calendarPresentation?.clear();
    calendarContinuation?.clear();
    const result = await session.resolvePending(text);
    // Generic pending-resume hook: covers every resume closure uniformly
    // (both applyIntents' own LLM-confirm closure, already separately
    // instrumented above, and any other pending built elsewhere — e.g.
    // phone_repair_needed/medical_read_pending), keyed only on CommitResult,
    // which is intentType-agnostic. intentType is honestly null here: the
    // original IntentRecord is not available at this call site.
    // Semantic Focus Contract V1 — Slice 4. `source` is hardcoded
    // 'deterministic' here (same pre-existing Slice 2 simplification as
    // `authorityTier` above — the original IntentRecord's capture source
    // is not available at this call site). This only under-classifies tier
    // in the narrow case of an LLM-sourced capture whose own domain writer
    // (e.g. medical_capture) returns its OWN nested 'pending' from inside
    // Build C's generic resume closure — that second-layer pending would
    // read as 'deterministic_unconfirmed' instead of 'llm_proposal'.
    // Disclosed, not fixed: both are non-authoritative tiers (nothing
    // becomes falsely authoritative), and fixing it requires threading the
    // original source through ConversationSession's pending-storage shape,
    // out of this slice's additive-only scope. When result.status is
    // 'committed', this hardcoding has no effect on the outcome at all —
    // classifyFocusAuthority only branches on `source` for non-committed
    // results.
    ledger?.push({
      establishedAt: Date.now(),
      utterance: text,
      intentType: null,
      operation: 'capture',
      outcome: commitResultOutcome(result.status),
      authorityTier: 'deterministic',
      assistantReplySummary: result.status === 'committed' || result.status === 'noop' || result.status === 'failed' ? result.ack : null,
      // Active Subject / Reference Continuity V1: threads a resume closure's
      // own referenceOnly signal (e.g. active-subject ambiguity resolution)
      // through to buildFocusEntry so a grounded reference is recorded as
      // tier:'conversational', never misread as an authoritative/proposal
      // capture. Every existing domain resume closure omits this field, so
      // this is a no-op for them (undefined, same as before).
      focus: buildFocusEntry(result.focus, { status: result.status, source: 'deterministic', referenceOnly: result.referenceOnly }),
    });
    return { handled: true, source: 'pending_resume', responseText: composeAck([result]), commits: [result] };
  }
  const exactlyOneNarrativePerson = discourse
    ? discourse.noteNarrativeUtterance(text).exactlyOneNarrativePerson
    : null;
  if (discourse) {
    console.log('[WCS]', JSON.stringify(discourse.snapshot()));
  }
  // 1a-cal) Calendar temporal continuation — one-turn follow-up after an
  //     authoritative calendar read. Fresh tier-1 read only; no answer replay.
  if (calendarContinuation?.canContinue()) {
    if (hasCalendarReadEvidence(text)) {
      calendarContinuation.clear();
      calendarPresentation?.clear();
    } else {
      const scope = parseCalendarTemporalFollowUp(text);
      if (scope) {
        calendarContinuation.clear();
        calendarPresentation?.clear();
        const { response } = await readCalendarScope(scope);
        return { handled: true, source: 'referent_resume', responseText: response, commits: [] };
      }
      recordContinuationRecoveryCandidate(
        continuationRecoveryCandidates,
        'calendar',
        CONTINUATION_RECOVERY_SAFE_LABEL.calendar,
      );
      calendarContinuation.clear();
    }
  }
  // 1a-pres) Calendar ordinal time inquiry — one turn after authoritative calendar read.
  //     Fresh by-id reread only; not transcript replay.
  if (calendarPresentation?.canContinue()) {
    const position = parseCalendarTimeInquiry(text);
    const livePresentation = calendarPresentation.peek();
    if (position !== null && livePresentation) {
      calendarPresentation.clear();
      const answered = answerCalendarTimeInquiry(livePresentation, position);
      return { handled: true, source: 'referent_resume', responseText: answered.responseText, commits: [] };
    }
    recordContinuationRecoveryCandidate(
      continuationRecoveryCandidates,
      'calendar',
      CONTINUATION_RECOVERY_SAFE_LABEL.calendar,
    );
    calendarPresentation.clear();
  }
  // 1a) Medication ordinal continuation — closed first/second-one speech act
  //     against the RAM presentation of ordered medication IDs. Not Flow C.
  //     Live presentation + V1 ordinal → index → ID → fresh by-id reread.
  //     Out-of-range retains the presentation so the user can retry.
  //     Bounded near-miss (this speech-act family, exact parse failed) retains
  //     for ONE repair turn, then clears. Unrelated next turn clears as unused.
  //     Does not consult the LLM or person-subject.
  if (medicationPresentation?.hasLive()) {
    const livePresentation = medicationPresentation.peek();
    const ordinalIndex = parseMedicationOrdinalIndex(text);
    if (livePresentation && ordinalIndex !== null) {
      const answered = answerMedicationOrdinal(livePresentation, ordinalIndex);
      if (answered.kind !== 'oor') {
        medicationPresentation.renew();
      }
      return { handled: true, source: 'referent_resume', responseText: answered.responseText, commits: [] };
    }
    if (livePresentation && isMedicationOrdinalNearMiss(text)) {
      const responseText = MEDICATION_ORDINAL_CONFUSION;
      if (livePresentation.repairAvailable) {
        medicationPresentation.consumeRepair();
      } else {
        medicationPresentation.clear();
      }
      return { handled: true, source: 'referent_resume', responseText, commits: [] };
    }
    recordContinuationRecoveryCandidate(
      continuationRecoveryCandidates,
      'medication',
      CONTINUATION_RECOVERY_SAFE_LABEL.medication,
    );
    medicationPresentation.clear();
  }
  // 1a2) Named grocery collection grant (F2) wins over live continuation.
  //      Explicit naming authorizes a fresh reread, not frozen live IDs.
  {
    const named = parseGroceryNamedCollectionRead(text);
    if (named.kind === 'ambiguous') {
      return {
        handled: true,
        source: 'referent_resume',
        responseText: ORDERED_PRESENTATION_CONFUSION,
        commits: [],
      };
    }
    if (named.kind === 'position') {
      const items = getPresentedOpenListItems('grocery');
      if (items.length === 0) {
        orderedPresentation?.clear();
        return {
          handled: true,
          source: 'referent_resume',
          responseText: composeOpenListSpeech('grocery', items),
          commits: [],
        };
      }
      const presentedIds = items.map((i) => i.id);
      subject?.clear();
      medicationPresentation?.clear();
      orderedPresentation?.establish('grocery', presentedIds);
      const resolved = resolvePositions(presentedIds, [named.n]);
      if (!resolved.ok) {
        return {
          handled: true,
          source: 'referent_resume',
          responseText: ORDERED_PRESENTATION_CONFUSION,
          commits: [],
        };
      }
      const row = getOpenListItemById(resolved.ids[0], 'grocery');
      if (!row) {
        return {
          handled: true,
          source: 'referent_resume',
          responseText: GROCERY_POSITION_STALE,
          commits: [],
        };
      }
      orderedPresentation?.renew();
      return {
        handled: true,
        source: 'referent_resume',
        responseText: formatGroceryItemReadback(row.body),
        commits: [],
      };
    }
  }
  // 1a3) Live grocery ordered-presentation READ — interpret BEFORE unused-clear.
  //      Mutation language is not a read; do not clear a live grocery holder yet.
  if (orderedPresentation?.hasLive()) {
    const liveOrdered = orderedPresentation.peek();
    if (liveOrdered?.owner === 'grocery' && !isPositionMutationLanguage(text)) {
      const interpreted = interpretPositionReference(text);
      if (interpreted.kind === 'position_reference' && interpreted.positions.length === 1) {
        const resolved = resolvePositions(liveOrdered.presentedIds, interpreted.positions);
        if (!resolved.ok) {
          return {
            handled: true,
            source: 'referent_resume',
            responseText: ORDERED_PRESENTATION_CONFUSION,
            commits: [],
          };
        }
        const row = getOpenListItemById(resolved.ids[0], 'grocery');
        if (!row) {
          return {
            handled: true,
            source: 'referent_resume',
            responseText: GROCERY_POSITION_STALE,
            commits: [],
          };
        }
        orderedPresentation.renew();
        return {
          handled: true,
          source: 'referent_resume',
          responseText: formatGroceryItemReadback(row.body),
          commits: [],
        };
      }
      if (interpreted.kind === 'ambiguous') {
        return { handled: true, source: 'referent_resume', responseText: ORDERED_PRESENTATION_CONFUSION, commits: [] };
      }
      if (interpreted.kind !== 'unsafe' && hasBoundedPositionEvidence(text)) {
        return { handled: true, source: 'referent_resume', responseText: ORDERED_PRESENTATION_CONFUSION, commits: [] };
      }
      recordContinuationRecoveryCandidate(
        continuationRecoveryCandidates,
        'grocery',
        CONTINUATION_RECOVERY_SAFE_LABEL.grocery,
      );
      orderedPresentation.clear();
    } else if (liveOrdered?.owner !== 'grocery') {
      orderedPresentation.clear();
    }
  }
  // 1a4) Grocery positional mutation — after reads, before unused-clear / routeIntent.
  {
    const parsed = parseGroceryPositionalMutation(text);
    if (parsed.kind !== 'not_this_act') {
      const named = hasGroceryNamedMutationCue(text);
      const live = orderedPresentation?.peek();
      const liveGrocery = live?.owner === 'grocery' ? live : null;

      if (parsed.kind === 'ambiguous' || parsed.kind === 'unresolved') {
        if (named || liveGrocery) {
          return {
            handled: true,
            source: 'referent_resume',
            responseText: ORDERED_PRESENTATION_CONFUSION,
            commits: [],
          };
        }
      } else {
        let presentedIds: string[] | null = null;
        if (named) {
          const items = getPresentedOpenListItems('grocery');
          if (items.length === 0) {
            orderedPresentation?.clear();
            return {
              handled: true,
              source: 'referent_resume',
              responseText: composeOpenListSpeech('grocery', items),
              commits: [],
            };
          }
          presentedIds = items.map((i) => i.id);
          subject?.clear();
          medicationPresentation?.clear();
          orderedPresentation?.establish('grocery', presentedIds);
        } else if (liveGrocery) {
          presentedIds = liveGrocery.presentedIds;
        } else {
          return {
            handled: true,
            source: 'referent_resume',
            responseText: ORDERED_PRESENTATION_CONFUSION,
            commits: [],
          };
        }
        const resolved = resolvePositions(presentedIds, [parsed.n]);
        if (!resolved.ok) {
          return {
            handled: true,
            source: 'referent_resume',
            responseText: ORDERED_PRESENTATION_CONFUSION,
            commits: [],
          };
        }
        const row = getOpenListItemById(resolved.ids[0], 'grocery');
        if (!row) {
          return {
            handled: true,
            source: 'referent_resume',
            responseText: GROCERY_POSITION_STALE,
            commits: [],
          };
        }
        const removed = markOpenListItemRemovedById(row.id, 'grocery');
        if (!removed) {
          return {
            handled: true,
            source: 'referent_resume',
            responseText: GROCERY_POSITION_STALE,
            commits: [],
          };
        }
        const remaining = getPresentedOpenListItems('grocery');
        if (remaining.length === 0) {
          orderedPresentation?.clear();
        } else {
          subject?.clear();
          medicationPresentation?.clear();
          orderedPresentation?.establish('grocery', remaining.map((i) => i.id));
        }
        return {
          handled: true,
          source: 'referent_resume',
          responseText: formatGroceryRemovalAck(removed.body, remaining),
          commits: [],
        };
      }
    }
    if (isPositionMutationLanguage(text) && orderedPresentation?.hasLive()) {
      const live = orderedPresentation.peek();
      if (
        live?.owner === 'grocery' &&
        hasBoundedPositionEvidence(text) &&
        !isGroceryMutationDomainBlocked(text)
      ) {
        return {
          handled: true,
          source: 'referent_resume',
          responseText: ORDERED_PRESENTATION_CONFUSION,
          commits: [],
        };
      }
      recordContinuationRecoveryCandidate(
        continuationRecoveryCandidates,
        'grocery',
        CONTINUATION_RECOVERY_SAFE_LABEL.grocery,
      );
      orderedPresentation.clear();
    }
  }
  // 1b) Flow C — closed pronoun-phone speech act against the one-turn
  //     conversational subject. Eligible referent consumes and clears.
  //     Any other next turn clears as unused. Explicit named asks are
  //     not this speech act and fall through to routeIntent.
  if (subject?.hasLive()) {
    subject.markReferentEvaluated();
    if (isReferentPhoneQuestion(text)) {
      const live = subject.peek();
      const responseText = live
        ? answerReferentPhone(live)
        : `I don't have a number for them yet.`;
      subject.clear();
      return { handled: true, source: 'referent_resume', responseText, commits: [] };
    }
    // Continuity Step 4: successful medical referent resolution (visit-date,
    // visit-outcome, upcoming-visit) RENEWS the subject instead of clearing
    // it, so a chain of related follow-up questions about the same doctor
    // resolves without re-naming him each time. Renewal reuses the existing
    // holder mechanism (establishMedical with the SAME identity) -- no new
    // topic stack, no persistence. A domain-mismatched live subject (family
    // or household) still returns null from every medical act below and
    // falls through unchanged -- never a fabricated cross-domain answer.
    const live = subject.peek();
    if (live && isReferentVisitDateQuestion(text)) {
      const responseText = await answerReferentVisitDate(live);
      if (responseText) {
        subject.establishMedical({ entityId: live.entityId, displayName: live.displayName });
        return { handled: true, source: 'referent_resume', responseText, commits: [] };
      }
    }
    if (live && isReferentVisitOutcomeQuestion(text)) {
      const responseText = await answerReferentVisitOutcome(live);
      if (responseText) {
        subject.establishMedical({ entityId: live.entityId, displayName: live.displayName });
        return { handled: true, source: 'referent_resume', responseText, commits: [] };
      }
    }
    if (live && isReferentUpcomingVisitQuestion(text)) {
      const responseText = await answerReferentUpcomingVisit(live);
      if (responseText) {
        subject.establishMedical({ entityId: live.entityId, displayName: live.displayName });
        return { handled: true, source: 'referent_resume', responseText, commits: [] };
      }
    }
    if (live) {
      const yearMatch = isReferentYearBoundedVisitQuestion(text);
      if (yearMatch) {
        const responseText = await answerReferentYearBoundedVisit(live, yearMatch.year);
        if (responseText) {
          subject.establishMedical({ entityId: live.entityId, displayName: live.displayName });
          return { handled: true, source: 'referent_resume', responseText, commits: [] };
        }
      }
    }
    const unused = subject.peek();
    if (unused?.displayName) {
      recordContinuationRecoveryCandidate(
        continuationRecoveryCandidates,
        'person',
        unused.displayName,
      );
    }
    subject.clear();
  }
  // 1c) Live operational-list continuation — structurally trailing-add against
  //     the RAM domain slot only. Domain is evidence, not write permission.
  if (discourse) {
    const continuationItem = parseOperationalListContinuationAdd(text);
    const liveDomain = discourse.peekDomain();
    if (continuationItem && liveDomain) {
      if (!isOperationalListItemShape(continuationItem)) {
        const listLabel = liveDomain.domain === 'todo' ? 'to-do' : 'grocery';
        return {
          handled: true,
          source: 'capture',
          responseText: `What did you want to add to your ${listLabel} list?`,
          commits: [],
        };
      }
      const intent: IntentRecord = liveDomain.domain === 'todo'
        ? { type: 'todo_add', body: continuationItem }
        : { type: 'list_add', items: [continuationItem], listName: 'grocery' };
      const { responseText, commits } = await applyIntents(
        [intent],
        text,
        session,
        { resolveContact: deps.resolveContact },
        'deterministic',
        undefined,
        ledger,
      );
      if (commits.some((c) => c.status === 'committed')) {
        discourse.establishDomain(liveDomain.domain);
      }
      return { handled: true, source: 'capture', responseText, commits };
    }
    const liveSet = discourse.peekCandidateSet();
    const demo = interpretCandidateSetDemonstrative(text, liveSet);
    if (demo.kind === 'resolved' && isAddShapedOperationalDemonstrative(text)) {
      const domain = liveDomain?.domain ?? liveSet?.domain ?? 'grocery';
      const intent: IntentRecord = domain === 'todo'
        ? { type: 'todo_add', body: demo.items.join(' and ') }
        : { type: 'list_add', items: demo.items, listName: 'grocery' };
      const { responseText, commits } = await applyIntents(
        [intent],
        text,
        session,
        { resolveContact: deps.resolveContact },
        'deterministic',
        undefined,
        ledger,
      );
      if (commits.some((c) => c.status === 'committed')) {
        discourse.establishDomain(domain === 'todo' ? 'todo' : 'grocery');
      }
      return { handled: true, source: 'capture', responseText, commits };
    }
  }
  // 2) The single routing authority — called exactly once per utterance.
  const routeDecision = await routeIntent(text, deps);
  // D-phone-repair, 2026-08-13: processUtterance is the sole boundary that
  // may call session.setPending (Spine §3a / Law 2) -- routeIntent itself
  // never touches session. This mirrors applyIntents' existing pending-arm
  // pattern, just for a RouteDecision-originated signal instead of a
  // DOMAIN_WRITER-originated one.
  if (routeDecision.kind === 'phone_repair_needed') {
    subject?.clear();
    medicationPresentation?.clear();
    orderedPresentation?.clear();
    calendarPresentation?.clear();
    session.setPending({
      pendingKey: routeDecision.pending.pendingKey,
      resume: routeDecision.pending.resume,
      kind: routeDecision.pending.kind,
      reaskPrompt: routeDecision.pending.reaskPrompt,
      correctable: routeDecision.pending.correctable,
    });
    return { handled: true, source: 'capture', responseText: routeDecision.pending.prompt, commits: [routeDecision.pending] };
  }
  // NEW — second occurrence of this exact arm pattern (phone_repair_needed
  // is the first). Not factored out yet — rule of three not met.
  if (routeDecision.kind === 'medical_read_pending') {
    subject?.clear();
    medicationPresentation?.clear();
    orderedPresentation?.clear();
    calendarPresentation?.clear();
    session.setPending({
      pendingKey: routeDecision.pending.pendingKey,
      resume: routeDecision.pending.resume,
      kind: routeDecision.pending.kind,
      reaskPrompt: routeDecision.pending.reaskPrompt,
      correctable: routeDecision.pending.correctable,
    });
    return { handled: true, source: 'capture', responseText: routeDecision.pending.prompt, commits: [routeDecision.pending] };
  }
  // 3) Converted-domain capture → commit loop.
  if (routeDecision.kind === 'capture' && allConverted(routeDecision.intents)) {
    const declineAck = routeDecision.reason === 'llm:capture:ambiguous_operational_list'
      ? formatOperationalListClarification(extractAmbiguousAcquisitionObject(text) ?? '')
      : undefined;
    // Conversational Presentation Contract V1: a Semantic Interpretation
    // ADMIT is already deterministically admitted; domain-writer confirmation
    // owns the capture. Keep RouteDecision.source as 'llm' (provenance). Do
    // not send this path through Build C's generic prompt.
    const domainConfirmOwnsCapture =
      routeDecision.source === 'llm'
      && routeDecision.reason === 'semantic_proposal:medication_admit';
    const llmGate = {
      ...(declineAck ? { declineAck } : {}),
      ...(domainConfirmOwnsCapture ? { domainConfirmOwnsCapture: true } : {}),
    };
    const { responseText, commits } = await applyIntents(
      routeDecision.intents,
      text,
      session,
      { resolveContact: deps.resolveContact },
      routeDecision.source,
      Object.keys(llmGate).length > 0 ? llmGate : undefined,
      ledger,
    );
    if (discourse && commits.some((c) => c.status === 'committed')) {
      for (const intent of routeDecision.intents) {
        if (intent.type === 'todo_add') discourse.establishDomain('todo');
        if (intent.type === 'list_add') {
          const listName = (intent.listName ?? 'grocery').toLowerCase();
          if (listName === 'todo' || listName === 'todos') discourse.establishDomain('todo');
          else if (listName === 'grocery') discourse.establishDomain('grocery');
        }
      }
    }
    return { handled: true, source: 'capture', responseText, commits };
  }
  if (
    routeDecision.kind === 'needs_clarification'
    && routeDecision.reason === 'ambiguous_operational_list'
  ) {
    const object = extractAmbiguousAcquisitionObject(text) ?? routeDecision.guess ?? '';
    const liveCandidates = discourse?.peekCandidateSet()?.items;
    const items = liveCandidates && liveCandidates.length >= 2
      ? [...liveCandidates]
      : splitCapturedTailSegments(object).filter(isOperationalListItemShape);
    if (liveCandidates && liveCandidates.length >= 2) discourse?.refreshCandidateSet();
    const prompt = formatOperationalListClarification(object);
    if (items.length >= 2) {
      const resume = async (userText: string): Promise<CommitResult> => {
        if (CONFIRM_NO_RE.test(userText.trim())) {
          return { status: 'noop', ack: prompt };
        }
        const resolution = parseOperationalDomainResolution(userText);
        if (resolution === 'grocery') {
          const writer = DOMAIN_WRITERS.list_add;
          if (!writer) return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
          const result = await writer.add(
            { type: 'list_add', items, listName: 'grocery' },
            userText,
          );
          if (result.status === 'committed') discourse?.establishDomain('grocery');
          return result;
        }
        if (resolution === 'todo') {
          const writer = DOMAIN_WRITERS.todo_add;
          if (!writer) return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
          const result = await writer.add(
            { type: 'todo_add', body: items.join(' and ') },
            userText,
          );
          if (result.status === 'committed') discourse?.establishDomain('todo');
          return result;
        }
        return { status: 'noop', ack: '' };
      };
      const pending: Extract<CommitResult, { status: 'pending' }> = {
        status: 'pending',
        prompt,
        pendingKey: 'operational_list_ambiguity',
        resume,
        reaskPrompt: prompt,
      };
      session.setPending({
        pendingKey: pending.pendingKey,
        resume: pending.resume,
        reaskPrompt: prompt,
      });
      return { handled: true, source: 'capture', responseText: prompt, commits: [pending] };
    }
  }
  // Flow C establishment — single owner. Immediately after routeIntent,
  // before returning the route decision to ChatScreen. ChatScreen must
  // not add family/household establishment fallbacks.
  // Person subject and medication presentation are mutually exclusive.
  // Establishing one clears the other so "the second one" cannot bind a
  // doctor and "his number" cannot bind a medication ID.
  const personEstablished = subject
    ? maybeEstablishConversationalSubject(text, routeDecision, subject)
    : false;
  if (personEstablished) {
    medicationPresentation?.clear();
    orderedPresentation?.clear();
    calendarPresentation?.clear();
  } else if (medicationPresentation) {
    maybeEstablishMedicationPresentation(
      routeDecision,
      medicationPresentation,
      subject ?? null,
      orderedPresentation,
      calendarPresentation,
    );
  }
  maybeEstablishGroceryPresentation(
    routeDecision,
    orderedPresentation,
    subject ?? null,
    medicationPresentation,
    calendarPresentation,
  );
  maybeEstablishCalendarContinuation(routeDecision, calendarContinuation);
  maybeEstablishCalendarPresentation(
    routeDecision,
    calendarPresentation,
    subject ?? null,
    medicationPresentation,
    orderedPresentation,
  );
  let continuityFocus: DomainFocusEnvelope | undefined;
  let continuityReferenceOnly: boolean | undefined;
  if (
    personEstablished
    && routeDecision.kind === 'device_read'
    && routeDecision.reason === 'medical:visit_history_read'
  ) {
    const live = subject?.peek();
    if (live?.domain === 'medical_doctor' && live.displayName.trim()) {
      continuityFocus = {
        kind: 'person',
        displayValue: live.displayName,
        resolverKey: live.entityId,
        referable: true,
      };
      continuityReferenceOnly = false;
    }
  }
  if (
    !continuityFocus
    && !personEstablished
    && exactlyOneNarrativePerson
    && admitsNarrativeContinuityPublication(routeDecision)
  ) {
    continuityFocus = {
      kind: 'person',
      displayValue: exactlyOneNarrativePerson,
      referable: true,
    };
    continuityReferenceOnly = true;
  }
  return {
    handled: false,
    routeDecision,
    continuationRecoveryCandidates,
    ...(continuityFocus
      ? { continuityFocus, continuityReferenceOnly: continuityReferenceOnly === true }
      : {}),
  };
}
