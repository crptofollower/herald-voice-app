import { routeIntent, DOMAIN_WRITERS, composeAck, allConverted } from './routeIntent';
import type { RouteDecision, CommitResult, ResolveContactFn } from './routeIntent';
import type { IntentRecord } from '../hooks/llmLayers';
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
  MedicationPresentationHolder,
  answerMedicationOrdinal,
  isMedicationOrdinalNearMiss,
  parseMedicationOrdinalIndex,
  MEDICATION_ORDINAL_CONFUSION,
} from './medicationPresentation';
import {
  OrderedPresentationHolder,
  parseGroceryReadPosition,
  isGroceryPositionNearMiss,
  resolvePositions,
  ORDERED_PRESENTATION_CONFUSION,
  GROCERY_POSITION_STALE,
} from './orderedPresentation';
import {
  getOpenListItemById,
  getPresentedOpenListItems,
  composeOpenListSpeech,
  formatGroceryItemReadback,
} from '../db/listRead';
import { parseGroceryNamedCollectionRead } from './groceryNamedCollectionReentry';

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
  | { handled: false; routeDecision: RouteDecision };

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
): Promise<{ responseText: string; commits: CommitResult[] }> {
  const results: CommitResult[] = [];
  for (const intent of intents) {
    const writer = DOMAIN_WRITERS[intent.type];
    if (!writer) continue;
    if (source === 'llm') {
      // Build C: do not call writer.add until the user confirms.
      results.push({
        status: 'pending',
        prompt: "Say yes and I'll remember that.",
        pendingKey: `llm_confirm:${intent.type}`,
        resume: async (userText: string): Promise<CommitResult> => {
          const trimmed = userText.trim();
          if (CONFIRM_NO_RE.test(trimmed)) {
            return { status: 'noop', ack: "No problem — I won't remember that." };
          }
          if (CONFIRM_YES_RE.test(trimmed)) {
            return writer.add(intent, rawText, ctx);
          }
          return { status: 'noop', ack: '' };
        },
      });
      continue;
    }
    results.push(await writer.add(intent, rawText, ctx));
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
): Promise<UtteranceOutcome> {
  const turnId = getActiveTurnId();
  latLog('processUtterance START', { turnId });
  subject?.beginUserTurn();
  medicationPresentation?.beginUserTurn();
  orderedPresentation?.beginUserTurn();
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
    const result = await session.resolvePending(text);
    return { handled: true, source: 'pending_resume', responseText: composeAck([result]), commits: [result] };
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
    medicationPresentation.clear();
  }
  // 1a2) Grocery ordered-presentation read-back — position → frozen ID →
  //      fresh by-id reread. Not mutation. Not medication. Not Flow C.
  if (orderedPresentation?.hasLive()) {
    const liveOrdered = orderedPresentation.peek();
    if (liveOrdered?.owner === 'grocery') {
      const position = parseGroceryReadPosition(text);
      if (position != null) {
        const resolved = resolvePositions(liveOrdered.presentedIds, [position]);
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
      if (isGroceryPositionNearMiss(text)) {
        const responseText = ORDERED_PRESENTATION_CONFUSION;
        if (liveOrdered.repairAvailable) {
          orderedPresentation.consumeRepair();
        } else {
          orderedPresentation.clear();
        }
        return { handled: true, source: 'referent_resume', responseText, commits: [] };
      }
    }
    orderedPresentation.clear();
  }
  // 1a3) F2 grocery named-collection re-entry — explicit grocery cue + one
  //      position, then a fresh grocery reread. Not F1/OPR intake. Positional
  //      language alone still has no authority when OPR is empty.
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
    subject.clear();
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
    const { responseText, commits } = await applyIntents(
      routeDecision.intents,
      text,
      session,
      { resolveContact: deps.resolveContact },
      routeDecision.source,
    );
    return { handled: true, source: 'capture', responseText, commits };
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
  } else if (medicationPresentation) {
    maybeEstablishMedicationPresentation(
      routeDecision,
      medicationPresentation,
      subject ?? null,
      orderedPresentation,
    );
  }
  return { handled: false, routeDecision };
}
