// useProactiveQueue.ts -- Polls /proactive on open + interval
// FIXES APPLIED (May 12 2026):
//   Bug 1: Stale closure / effect re-run loop
//     Root cause: lastPolled was a useCallback dep → poll got a new reference
//     on every successful poll → useEffect ([poll]) tore down and rebuilt the
//     AppState listener + setInterval after every fetch. Fix: read lastPolled
//     via useStore.getState() inside poll (imperative, not reactive). This
//     breaks the dep chain: poll now only changes when userId changes.
//
//   Bug 2: Hydration gap — userId generated at module init time, not yet
//     hydrated from AsyncStorage. Fix: wait for persist.hasHydrated() before
//     ever calling poll.
//
//   Extra: interval timer is now a ref so it survives userId changes without
//     the double-subscription window that the old pattern had.

import { useCallback, useEffect, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import { fetchProactiveQueue } from "../api/herald";
import { useStore } from "../store/useStore";
import { PROACTIVE_POLL_MS } from "../constants/api";

const DEBOUNCE_MS = 60 * 1000; // 60 s minimum between polls

export function useProactiveQueue() {
  // Only subscribe to userId — the only value that should change the
  // polling target. lastPolled is read imperatively inside poll() so it
  // never enters the dep array and never causes the effect to re-run.
  const userId = useStore((s) => s.userId);
  const setProactiveItems = useStore((s) => s.setProactiveItems);

  const appState  = useRef<AppStateStatus>(AppState.currentState);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // BUG 1 FIX: poll is stable for the lifetime of a given userId.
  // It reads lastPolled imperatively from the store — no closure capture,
  // no reactive subscription → no identity change after each fetch.
  const poll = useCallback(async () => {
    // BUG 2 FIX: bail out until the store has finished hydrating from
    // AsyncStorage. Without this guard, the first poll fires with the
    // ephemeral userId generated at module-init time (user_1746xxxxxx)
    // before the persisted canonical userId has been loaded.
    if (!useStore.persist.hasHydrated()) return;

    const { lastPolled } = useStore.getState(); // imperative read — no dep
    const now = Date.now();
    if (lastPolled && now - lastPolled < DEBOUNCE_MS) return;

    // Guard: don't poll for an empty/unset userId (pre-onboarding state)
    if (!userId || userId === "") return;

    try {
      const result = await fetchProactiveQueue(userId);
      setProactiveItems(result.items);
    } catch {
      // Proactive queue is non-critical. Network errors are swallowed.
      // DO NOT update lastPolled on failure so a retry can happen on the
      // next interval tick without waiting the full 60 s debounce.
    }
  }, [userId, setProactiveItems]); // stable: lastPolled no longer here

  useEffect(() => {
    // Attach AppState listener once per userId.
    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (
          appState.current.match(/inactive|background/) &&
          nextState === "active"
        ) {
          poll();
        }
        appState.current = nextState;
      }
    );

    // Poll immediately on mount / userId change.
    poll();

    // Periodic poll. The interval is now stable for the life of a userId —
    // it is NOT reset after every successful fetch (old bug).
    pollTimer.current = setInterval(poll, PROACTIVE_POLL_MS);

    return () => {
      subscription.remove();
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [poll]); // poll only changes when userId changes — interval now stable
}
