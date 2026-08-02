export type TimeoutHandle = { clear: () => void };
export type ScheduleTimeout = (fn: () => void, ms: number) => TimeoutHandle;

export const defaultScheduleTimeout: ScheduleTimeout = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return { clear: () => clearTimeout(id) };
};

export function createSuspendCoordinator(
  timeoutMs: number,
  scheduleTimeout: ScheduleTimeout = defaultScheduleTimeout,
  onTimeout: () => void = () =>
    console.warn('[useMic] suspendForSpeech: native "end" not confirmed within timeout'),
) {
  let pendingResolve: ((result: { confirmed: boolean }) => void) | null = null;
  let pendingTimer: TimeoutHandle | null = null;

  function resolvePending(confirmed: boolean) {
    const resolve = pendingResolve;
    if (pendingTimer) {
      pendingTimer.clear();
      pendingTimer = null;
    }
    pendingResolve = null;
    if (resolve) resolve({ confirmed });
  }

  function beginSuspend(stopFn: () => void): Promise<{ confirmed: boolean }> {
    return new Promise((resolve) => {
      resolvePending(false);
      pendingResolve = resolve;
      pendingTimer = scheduleTimeout(() => {
        onTimeout();
        resolvePending(false);
      }, timeoutMs);
      try {
        stopFn();
      } catch {
        resolvePending(false);
      }
    });
  }

  function onNativeEnd() {
    resolvePending(true);
  }

  function cancel() {
    resolvePending(false);
  }

  return { beginSuspend, onNativeEnd, cancel };
}
