// src/store/useStore.ts
// Herald global state -- Zustand + AsyncStorage persistence.
//
// Changes May 12, 2026:
//   - userId now uses Crypto.randomUUID() -- eliminates Date.now() collisions
//   - Added hardReset() -- creates fresh userId, clears onboarding (support tool)
//   - Freddie slice: owner-only state, always refetched (not persisted)
//   - Proactive slice: items + unread count + lastPolled (not persisted)
//   - Persisted: userId, name, persona, isOwner, onboardingComplete, voice prefs,
//                last 100 messages

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import type { PersonaKey } from "../constants/personas";
import type {
  Message,
  ProactiveItem,
  FreddieStatus,
} from "../api/herald";
import { DEFAULT_PERSONA } from "../constants/personas";

// ─── Persisted user slice ─────────────────────────────────────────────────────

interface UserState {
  userId: string;
  name: string;
  persona: PersonaKey;
  isOwner: boolean;
  onboardingComplete: boolean;
  voiceEnabled: boolean;
  ttsEnabled: boolean;
  isMuted: boolean;

  setUser: (userId: string, name: string) => void;
  setPersona: (p: PersonaKey) => void;
  setOnboardingComplete: () => void;
  toggleVoice: () => void;
  toggleTTS: () => void;
  toggleMute: () => void;
  setOwner: (v: boolean) => void;
}

// ─── Chat slice ───────────────────────────────────────────────────────────────

interface ChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;

  addMessage: (msg: Message) => void;
  setMessages: (msgs: Message[]) => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
  clearChat: () => void;
}

// ─── Proactive slice (transient -- always refetched) ─────────────────────────

interface ProactiveState {
  items: ProactiveItem[];
  unreadCount: number;
  lastPolled: number | null;

  setProactiveItems: (items: ProactiveItem[]) => void;
  markRead: (itemId: string) => void;
  markAllRead: () => void;
}

// ─── Freddie slice (owner only, transient) ────────────────────────────────────

interface FreddieState {
  status: FreddieStatus | null;
  statusAge: number | null;

  setFreddieStatus: (s: FreddieStatus) => void;
}

// ─── Reset ────────────────────────────────────────────────────────────────────

interface ResetState {
  // Nuclear reset: new userId, clears onboarding. Used in support / debug.
  hardReset: () => void;
}

// ─── Combined ────────────────────────────────────────────────────────────────

type Store = UserState &
  ChatState &
  ProactiveState &
  FreddieState &
  ResetState;

export const useStore = create<Store>()(
  persist(
    (set) => ({
      // ── User ────────────────────────────────────────────────────────────
      // Crypto.randomUUID() -- no collisions even on rapid reinstalls
      userId: Crypto.randomUUID(),
      name: "",
      persona: DEFAULT_PERSONA,
      isOwner: false,
      onboardingComplete: false,
      voiceEnabled: true,
      ttsEnabled: true,
      isMuted: false,

      setUser: (userId, name) => set({ userId, name }),
      setPersona: (persona) => set({ persona }),
      setOnboardingComplete: () => set({ onboardingComplete: true }),
      toggleVoice: () => set((s) => ({ voiceEnabled: !s.voiceEnabled })),
      toggleTTS: () => set((s) => ({ ttsEnabled: !s.ttsEnabled })),
      toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
      setOwner: (isOwner) => set({ isOwner }),

      // ── Chat ────────────────────────────────────────────────────────────
      messages: [],
      isLoading: false,
      error: null,

      addMessage: (msg) =>
        set((s) => ({ messages: [...s.messages, msg] })),
      setMessages: (messages) => set({ messages }),
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error }),
      clearChat: () => set({ messages: [] }),

      // ── Proactive (not persisted) ────────────────────────────────────────
      items: [],
      unreadCount: 0,
      lastPolled: null,

      setProactiveItems: (items) => {
        const unreadCount = items.filter((i) => !i.read).length;
        set({ items, unreadCount, lastPolled: Date.now() });
      },
      markRead: (itemId) =>
        set((s) => {
          const items = s.items.map((i) =>
            i.id === itemId ? { ...i, read: true } : i
          );
          return { items, unreadCount: items.filter((i) => !i.read).length };
        }),
      markAllRead: () =>
        set((s) => ({
          items: s.items.map((i) => ({ ...i, read: true })),
          unreadCount: 0,
        })),

      // ── Freddie (not persisted) ──────────────────────────────────────────
      status: null,
      statusAge: null,

      setFreddieStatus: (status) =>
        set({ status, statusAge: Date.now() }),

      // ── Hard reset ───────────────────────────────────────────────────────
      hardReset: () =>
        set({
          userId: Crypto.randomUUID(),
          name: "",
          persona: DEFAULT_PERSONA,
          isOwner: false,
          onboardingComplete: false,
          voiceEnabled: true,
          ttsEnabled: true,
          isMuted: false,
          messages: [],
          isLoading: false,
          error: null,
          items: [],
          unreadCount: 0,
          lastPolled: null,
          status: null,
          statusAge: null,
        }),
    }),
    {
      name: "herald-store-v2",
      storage: createJSONStorage(() => AsyncStorage),
      // Proactive + Freddie always refetched on app open -- never persist them.
      partialize: (state) => ({
        userId: state.userId,
        name: state.name,
        persona: state.persona,
        isOwner: state.isOwner,
        onboardingComplete: state.onboardingComplete,
        voiceEnabled: state.voiceEnabled,
        ttsEnabled: state.ttsEnabled,
        isMuted: state.isMuted,
        // Last 100 messages -- conversation continuity across restarts
        messages: state.messages.slice(-100),
      }),
    }
  )
);

// ─── Selectors (use these in components to avoid unnecessary re-renders) ──────

export const selectPersona = (s: Store) => s.persona;
export const selectIsOwner = (s: Store) => s.isOwner;
export const selectUnread = (s: Store) => s.unreadCount;
export const selectMessages = (s: Store) => s.messages;
export const selectUserId = (s: Store) => s.userId;
