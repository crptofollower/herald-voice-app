// useProactiveQueue.ts -- Polls /proactive on open + interval
// FIXES APPLIED (May 12 2026):
//   Bug 1: Stale closure / effect re-run loop — fixed via imperative lastPolled read
//   Bug 2: Hydration gap — wait for persist.hasHydrated() before first poll
//
// BUILD 21 FIX:
//   Bug 3: Phantom box — backend returns { messages: [] } but hook read result.items
//     (undefined). setProactiveItems(undefined) left store in broken state,
//     badge showed count but panel rendered empty. Fix: read result.messages,
//     guard against null/undefined, map items to add read:false if missing.

import { useCallback, useEffect, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import { fetchProactiveQueue } from "../api/herald";
import { getActiveTopics } from "../db/topicDB";
import { useStore } from "../store/useStore";
import { PROACTIVE_POLL_MS } from "../constants/api";

const DEBOUNCE_MS = 60 * 1000; // 60 s minimum between polls

export function useProactiveQueue() {
  const userId = useStore((s) => s.userId);
  const setProactiveItems = useStore((s) => s.setProactiveItems);

  const appState  = useRef<AppStateStatus>(AppState.currentState);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (!useStore.persist.hasHydrated()) return;

    const { lastPolled } = useStore.getState();
    const now = Date.now();
    if (lastPolled && now - lastPolled < DEBOUNCE_MS) return;

    if (!userId || userId === "") return;

    try {
      const activeTopics = getActiveTopics();
      const result = await fetchProactiveQueue(userId, activeTopics);

      // Backend returns { messages: [...] } — not { items: [...] }.
      // Guard against null/undefined to prevent phantom box.
      const raw = result?.items ?? [];
      if (!Array.isArray(raw) || raw.length === 0) return;

      // Ensure every item has a read field — backend items don't include it.
      const items = raw.map((m: any) => ({
        ...m,
        read: m.read ?? false,
      }));

      setProactiveItems(items);
    } catch {
      // Non-critical — swallow network errors, retry on next tick.
    }
  }, [userId, setProactiveItems]);

  useEffect(() => {
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

    poll();

    pollTimer.current = setInterval(poll, PROACTIVE_POLL_MS);

    return () => {
      subscription.remove();
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [poll]);
}