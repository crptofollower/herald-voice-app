// src/store/useStore.ts
// Herald global state -- Zustand + AsyncStorage persistence.
//
// Changes May 17 2026:
//   - Added aiName + setAiName (the name the user gives their Herald agent).
//     Persisted so it survives restarts. Used in ChatScreen header and greeting.
//     Mickey named his "Harry." This is the personalization hook.
//
// Changes May 16 2026:
//   - Added _hasHydrated flag to fix onboarding loop.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import type { PersonaKey } from "../constants/personas";
import type { Message, ProactiveItem, FreddieStatus } from "../api/herald";
import { DEFAULT_PERSONA } from "../constants/personas";

// ─── Slices ───────────────────────────────────────────────────────────────────

interface UserState {
  userId: string;
  name: string;
  aiName: string;            // what the user calls their Herald (e.g. "Harry", "Maya")
  persona: PersonaKey;
  isOwner: boolean;
  onboardingComplete: boolean;
  voiceEnabled: boolean;
  ttsEnabled: boolean;
  isMuted: boolean;

  location: string;
  confirmedCity: string;
  setLocation: (loc: string) => void;
  setConfirmedCity: (city: string) => void;
  setUser: (userId: string, name: string) => void;
  setAiName: (name: string) => void;
  setPersona: (p: PersonaKey) => void;
  setOnboardingComplete: () => void;
  toggleVoice: () => void;
  toggleTTS: () => void;
  toggleMute: () => void;
  setOwner: (v: boolean) => void;
}

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

interface ProactiveState {
  items: ProactiveItem[];
  unreadCount: number;
  lastPolled: number | null;

  setProactiveItems: (items: ProactiveItem[]) => void;
  markRead: (itemId: string) => void;
  markAllRead: () => void;
}

interface FreddieState {
  status: FreddieStatus | null;
  statusAge: number | null;
  setFreddieStatus: (s: FreddieStatus) => void;
}

interface HydrationState {
  _hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;
}

interface ResetState {
  hardReset: () => void;
}

type Store = UserState & ChatState & ProactiveState & FreddieState & HydrationState & ResetState;

// ─── Store ────────────────────────────────────────────────────────────────────

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      // ── User ──────────────────────────────────────────────────────────────
      userId: Crypto.randomUUID(),
      name: "",
      aiName: "Herald",      // default -- overwritten during onboarding
      persona: DEFAULT_PERSONA,
      isOwner: false,
      onboardingComplete: false,
      voiceEnabled: true,
      ttsEnabled: true,
      isMuted: false,

      location: "",
      confirmedCity: "",
      setLocation:           (location)     => set({ location }),
      setConfirmedCity:      (confirmedCity)=> set({ confirmedCity }),
      setUser:               (userId, name) => set({ userId, name }),
      setAiName:             (aiName)       => set({ aiName: aiName || "Herald" }),
      setPersona:            (persona)      => set({ persona }),
      setOnboardingComplete: () => {
        const { userId, name } = get();
        if (!userId || !name || userId.trim() === '' || name.trim() === '') {
          console.warn('[useStore] setOnboardingComplete blocked -- userId or name missing');
          return;
        }
        set({ onboardingComplete: true });
      },
      toggleVoice:           ()             => set((s) => ({ voiceEnabled: !s.voiceEnabled })),
      toggleTTS:             ()             => set((s) => ({ ttsEnabled:   !s.ttsEnabled })),
      toggleMute:            ()             => set((s) => ({ isMuted:      !s.isMuted })),
      setOwner:              (isOwner)      => set({ isOwner }),

      // ── Chat ──────────────────────────────────────────────────────────────
      messages: [],
      isLoading: false,
      error: null,

      addMessage:  (msg)      => set((s) => ({ messages: [...s.messages, msg] })),
      setMessages: (messages) => set({ messages }),
      setLoading:  (isLoading)=> set({ isLoading }),
      setError:    (error)    => set({ error }),
      clearChat:   ()         => set({ messages: [] }),

      // ── Proactive (not persisted) ──────────────────────────────────────────
      items: [],
      unreadCount: 0,
      lastPolled: null,

      setProactiveItems: (items) => {
        const unreadCount = items.filter((i) => !i.read).length;
        set({ items, unreadCount, lastPolled: Date.now() });
      },
      markRead: (itemId) =>
        set((s) => {
          const items = s.items.map((i) => i.id === itemId ? { ...i, read: true } : i);
          return { items, unreadCount: items.filter((i) => !i.read).length };
        }),
      markAllRead: () =>
        set((s) => ({
          items: s.items.map((i) => ({ ...i, read: true })),
          unreadCount: 0,
        })),

      // ── Freddie (not persisted) ────────────────────────────────────────────
      status: null,
      statusAge: null,
      setFreddieStatus: (status) => set({ status, statusAge: Date.now() }),

      // ── Hydration flag ─────────────────────────────────────────────────────
      _hasHydrated: false,
      setHasHydrated: (v) => set({ _hasHydrated: v }),

      // ── Hard reset ─────────────────────────────────────────────────────────
      hardReset: () =>
        set({
          userId: Crypto.randomUUID(),
          name: "", aiName: "Herald", persona: DEFAULT_PERSONA,
          isOwner: false, onboardingComplete: false,
          voiceEnabled: true, ttsEnabled: true, isMuted: false,
          messages: [], isLoading: false, error: null,
          location: "", confirmedCity: "",
          items: [], unreadCount: 0, lastPolled: null,
          status: null, statusAge: null,
        }),
    }),
    {
      name: "herald-store-v4",
      storage: createJSONStorage(() => AsyncStorage),

      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },

      // Persist what survives restarts. aiName added so chosen name persists.
      partialize: (state) => ({
        userId:             state.userId,
        name:               state.name,
        aiName:             state.aiName,
        persona:            state.persona,
        isOwner:            state.isOwner,
        onboardingComplete: state.onboardingComplete,
        voiceEnabled:       state.voiceEnabled,
        ttsEnabled:         state.ttsEnabled,
        isMuted:            state.isMuted,
        messages:           state.messages.slice(-100),
        location:           state.location,
        confirmedCity:      state.confirmedCity,
      }),
    }
  )
);

// ─── Selectors ────────────────────────────────────────────────────────────────

export const selectPersona  = (s: Store) => s.persona;
export const selectIsOwner  = (s: Store) => s.isOwner;
export const selectUnread   = (s: Store) => s.unreadCount;
export const selectMessages = (s: Store) => s.messages;
export const selectUserId   = (s: Store) => s.userId;
export const selectHydrated = (s: Store) => s._hasHydrated;
export const selectAiName   = (s: Store) => s.aiName;