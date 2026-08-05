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
