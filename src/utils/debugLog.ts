// Temporary debug logging — adb logcat | findstr HERALD-DEBUG
const SESSION_ID = 'part-a-timer';

export function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = 'timer-regression'
): void {
  console.log('[HERALD-DEBUG]', JSON.stringify({
    sessionId: SESSION_ID,
    location,
    message,
    data,
    timestamp: Date.now(),
    hypothesisId,
    runId,
  }));
}
