export function evaluateEmptySessionRecovery(snapshot: {
  armedToken: number;
  currentToken: number;
  engineActive: boolean;
  turnActive: boolean;
  bufferHasContent: boolean;
}): 'fire' | 'stale_session' | 'state_changed' {
  if (snapshot.armedToken !== snapshot.currentToken) return 'stale_session';
  if (!snapshot.engineActive || snapshot.turnActive || snapshot.bufferHasContent) return 'state_changed';
  return 'fire';
}

/**
 * Pure predicate: should a pending empty-session recovery timer be
 * cancelled given this NATIVE_RESULT event? True for any result --
 * final or partial -- that carries non-empty transcript content, as
 * long as a timer is actually armed. No timers, no refs, no React --
 * mirrors the existing evaluateEmptySessionRecovery seam so this can
 * run under the tsx gate the same way that one does.
 */
export function shouldCancelEmptySessionRecovery(params: {
  timerArmed: boolean;
  transcript: string | undefined | null;
}): boolean {
  return params.timerArmed && !!params.transcript?.trim();
}
