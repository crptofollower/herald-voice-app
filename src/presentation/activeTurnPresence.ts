/**
 * Active Turn Presence V1 — pure presentation derivation.
 *
 * Conversation fades; useful information persists when useful.
 * Conversation must not fade before the exchange has actually happened.
 *
 * Derives phase/presence from existing lifecycle facts. Does not invent
 * execution timeouts or terminal outcomes.
 */

export type ActiveTurnPhase =
  | 'idle'
  | 'final_captured'
  | 'interpreting'
  | 'responding'
  | 'speaking'
  | 'completed'
  | 'clarification'
  | 'failure';

export type ActiveTurnTerminalOutcome =
  | 'none'
  | 'completed'
  | 'clarification'
  | 'failure';

export type ActiveTurnPresenceFacts = {
  /** Owning turn id; null means no active exchange. */
  activeTurnId: number | null;
  /** Turn-scoped final user utterance (not heardPreview). */
  activeUserUtterance: string | null;
  /** sendMessage / sending still owns this turn. */
  turnInFlight: boolean;
  isWaiting: boolean;
  isStreaming: boolean;
  streamingContent: string;
  isSpeaking: boolean;
  /** User bubble already committed into the session transcript for this turn. */
  userUtteranceCommittedInTranscript: boolean;
  /** Committed assistant prose for this turn, if any. */
  assistantResponseText: string | null;
  /** Reflects existing execution terminals only — never presentation timing. */
  terminalOutcome: ActiveTurnTerminalOutcome;
  /**
   * Orthogonal capability-card fact. Does not replace conversational presence.
   * Included so callers can assert coexistence without coupling to card UI.
   */
  capabilitySurfaceActive?: boolean;
};

export type ActiveTurnPresentation = {
  phase: ActiveTurnPhase;
  showUserUtterance: boolean;
  showProcessingIndicator: boolean;
  showResponseContent: boolean;
  userUtterance: string | null;
  responseContent: string | null;
  activeTurnId: number | null;
  capabilitySurfaceActive: boolean;
};

function trimText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function hasResponseContent(facts: ActiveTurnPresenceFacts): boolean {
  if (trimText(facts.streamingContent).length > 0) return true;
  if (trimText(facts.assistantResponseText).length > 0) return true;
  return false;
}

/**
 * Pure phase derivation from lifecycle facts.
 */
export function deriveActiveTurnPhase(facts: ActiveTurnPresenceFacts): ActiveTurnPhase {
  if (facts.activeTurnId == null || !trimText(facts.activeUserUtterance)) {
    return 'idle';
  }

  if (facts.terminalOutcome === 'failure') return 'failure';
  if (facts.terminalOutcome === 'clarification') return 'clarification';

  // Ownership released after a normal completion — fade may take over.
  if (
    facts.terminalOutcome === 'completed' &&
    !facts.turnInFlight &&
    !facts.isStreaming &&
    !facts.isSpeaking &&
    !facts.isWaiting
  ) {
    return 'completed';
  }

  if (hasResponseContent(facts)) {
    if (facts.isSpeaking) return 'speaking';
    return 'responding';
  }

  if (facts.turnInFlight || facts.isWaiting || facts.isStreaming) {
    return 'interpreting';
  }

  // Final captured but ownership not yet marked in-flight (narrow UI race).
  return 'final_captured';
}

/**
 * Whether the processing indicator should paint yet.
 * User utterance presence is independent — always immediate when required.
 */
export function shouldShowProcessingIndicator(
  phase: ActiveTurnPhase,
  elapsedMs: number,
  thresholdMs: number = 200,
): boolean {
  if (phase !== 'interpreting' && phase !== 'final_captured') return false;
  if (thresholdMs <= 0) return true;
  return elapsedMs >= thresholdMs;
}

export function deriveActiveTurnPresentation(
  facts: ActiveTurnPresenceFacts,
  opts?: { elapsedMs?: number; processingIndicatorThresholdMs?: number },
): ActiveTurnPresentation {
  const phase = deriveActiveTurnPhase(facts);
  const utterance = trimText(facts.activeUserUtterance) || null;
  const response =
    trimText(facts.streamingContent) ||
    trimText(facts.assistantResponseText) ||
    null;

  const exchangeOpen =
    phase === 'final_captured' ||
    phase === 'interpreting' ||
    phase === 'responding' ||
    phase === 'speaking' ||
    phase === 'clarification' ||
    phase === 'failure';

  // Keep turn-scoped utterance visible for the open exchange. Transcript
  // commit does not retire it — workspace truncation can hide committed
  // bubbles while capability cards remain.
  const showUserUtterance = exchangeOpen && utterance != null;

  const elapsed = opts?.elapsedMs ?? Number.POSITIVE_INFINITY;
  const threshold = opts?.processingIndicatorThresholdMs ?? 200;
  const showProcessingIndicator =
    !hasResponseContent(facts) &&
    shouldShowProcessingIndicator(phase, elapsed, threshold);

  const showResponseContent =
    response != null &&
    (phase === 'responding' ||
      phase === 'speaking' ||
      phase === 'clarification' ||
      phase === 'failure');

  return {
    phase,
    showUserUtterance: Boolean(showUserUtterance),
    showProcessingIndicator,
    showResponseContent: Boolean(showResponseContent),
    userUtterance: showUserUtterance ? utterance : null,
    responseContent: showResponseContent ? response : null,
    activeTurnId: facts.activeTurnId,
    capabilitySurfaceActive: facts.capabilitySurfaceActive === true,
  };
}

/**
 * Never-blank invariant: an open active turn must present user presence
 * and/or processing and/or response content.
 */
export function isActiveTurnVisuallyPresent(presentation: ActiveTurnPresentation): boolean {
  if (presentation.phase === 'idle' || presentation.phase === 'completed') return true;
  return (
    presentation.showUserUtterance ||
    presentation.showProcessingIndicator ||
    presentation.showResponseContent
  );
}

export function assertActiveTurnNeverBlank(
  facts: ActiveTurnPresenceFacts,
  opts?: { elapsedMs?: number; processingIndicatorThresholdMs?: number },
): ActiveTurnPresentation {
  const presentation = deriveActiveTurnPresentation(facts, opts);
  if (presentation.phase !== 'idle' && presentation.phase !== 'completed') {
    if (!isActiveTurnVisuallyPresent(presentation)) {
      throw new Error(
        `Active Turn Presence never-blank violated: phase=${presentation.phase}`,
      );
    }
  }

  // At elapsedMs=0 the indicator may be delayed, but utterance must remain.
  if (presentation.phase === 'interpreting' || presentation.phase === 'final_captured') {
    const immediate = deriveActiveTurnPresentation(facts, {
      elapsedMs: 0,
      processingIndicatorThresholdMs: opts?.processingIndicatorThresholdMs ?? 200,
    });
    if (!immediate.showUserUtterance && !immediate.showResponseContent) {
      throw new Error(
        'Active Turn Presence never-blank violated at elapsedMs=0 (utterance must remain)',
      );
    }
  }

  return presentation;
}

/** Former S24 blank shape — local processing, waiting false, no stream content. */
export function formerBlankFailureFacts(
  overrides?: Partial<ActiveTurnPresenceFacts>,
): ActiveTurnPresenceFacts {
  return {
    activeTurnId: 1,
    activeUserUtterance: 'I was talking to Mickey about the Herald build.',
    turnInFlight: true,
    isWaiting: false,
    isStreaming: false,
    streamingContent: '',
    isSpeaking: false,
    userUtteranceCommittedInTranscript: false,
    assistantResponseText: null,
    terminalOutcome: 'none',
    capabilitySurfaceActive: false,
    ...overrides,
  };
}
