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
): void {
  if (routeDecision.kind === 'device_read' && routeDecision.reason === 'family:read') {
    const intent = detectFamilyRead(text);
    if (!intent) return;
    const match = resolveFamilyRead(intent);
    if (match) holder.establishFamily(match);
    return;
  }
  if (
    routeDecision.kind === 'device_action' &&
    routeDecision.actionIntent.type === 'household_read' &&
    routeDecision.actionIntent.intent.type === 'service_provider'
  ) {
    const match = resolveHouseholdProvider(routeDecision.actionIntent.intent);
    if (match) holder.establishHousehold(match);
    return;
  }
  // Continuity Step 3: a completed deterministic most-recent-visit read that
  // identified exactly one doctor establishes that doctor as the subject.
  // Re-derives identity from the same deterministic reader the branch used —
  // it does not trust the response string. No name ⇒ no subject (fail closed).
  if (routeDecision.kind === 'device_read' && routeDecision.reason === 'medical:visit_history_read') {
    const visit = getLastVisit(extractDoctorName(text));
    const name = visit?.doctorName?.trim();
    if (name) holder.establishMedical({ entityId: name, displayName: name });
  }
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
): Promise<UtteranceOutcome> {
  const turnId = getActiveTurnId();
  latLog('processUtterance START', { turnId });
  subject?.beginUserTurn();
  // 0) Law 0 — emergency preempts everything (Spine §3a). Checked before pending
  //    resolution, before routing, before any classifier. A held pending is
  //    RELEASED, never resumed — no re-ask, no ladder, no ack generated here
  //    (ChatScreen speaks the actual emergency reply). No route decision is
  //    ever computed for an emergency utterance.
  if (detectEmergency(text)) {
    if (session.hasPending()) session.clearPending();
    subject?.clear();
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
    const result = await session.resolvePending(text);
    return { handled: true, source: 'pending_resume', responseText: composeAck([result]), commits: [result] };
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
  if (subject) maybeEstablishConversationalSubject(text, routeDecision, subject);
  return { handled: false, routeDecision };
}
