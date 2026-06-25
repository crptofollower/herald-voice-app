// src/screens/ChatScreen.tsx — Herald main interface
//
// CHANGES Build 21 — calendar write grace window + fresh local_date/local_time per send
//
// CHANGES May 17, 2026 (scroll + ambient mode):
//
//   SCROLL SNAP FIX:
//     FlatList no longer snaps back to bottom when user scrolls up to read.
//     isAtBottomRef tracks scroll position. Auto-scroll only fires when
//     the user is already near the bottom (< 80px from end).
//     User can now scroll up through a long Freddie response without
//     being yanked back down by incoming tokens.
//
//   AMBIENT MODE (idle resume):
//     If Herald hasn't been used for 15 minutes, the next open shows a
//     clean screen with a fresh greeting -- "Good evening Mike, 84 degrees
//     in Plano, what's on your mind?" -- instead of a wall of old chat.
//     Old messages are still in memory for API context. Only the display
//     resets. lastInteractionRef tracks idle time across foreground/background.
//
//   All prior features intact: streaming, progressive TTS, intent system,
//   calendar/maps/sms, Honesty Contract, proactive panel, Freddie card.

import { Animated } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  SafeAreaView,
  Linking,
  AppState,
  AppStateStatus,
} from "react-native";
import * as Calendar from "expo-calendar";
import * as Network from "expo-network";
import * as Haptics from 'expo-haptics';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from "../store/useStore";
import { API_BASE } from "../constants/api";
import { PERSONAS, DEFAULT_PERSONA } from "../constants/personas";
import {
  askHeraldStream,
  markProactiveRead,
  fetchGreeting,
  type Message,
} from "../api/herald";
import { useSpeech } from "../hooks/useSpeech";
import { useProactiveQueue } from "../hooks/useProactiveQueue";
import { PersonaBackground } from "../components/PersonaBackground";
import { MessageBubble } from "../components/MessageBubble";
import { ProactiveCard } from "../components/ProactiveCard";
import { IntentCard, type ActionStatus } from "../components/IntentCard";
import { generateId } from "../utils/id";
import { normalizePhone } from "../utils/phone";
import { normalizeInput } from "../utils/normalizeInput";
import { beacon } from "../utils/diag";
import { useCalendar } from "../hooks/useCalendar";
import { useLocation } from "../hooks/useLocation";
import { useMic } from "../hooks/useMic";
import { useRaiseToWake } from "../hooks/useRaiseToWake";
import { useDeviceMemory } from "../hooks/useDeviceMemory";
import { useLocalLLM } from '../hooks/useLocalLLM';
import { classifyWithLLM, phraseWithLLM } from '../hooks/llmLayers';
import { answerFromDevice } from '../utils/localAnswers';
import { writeTurnObservation } from '../utils/personaContext';
import { classifyQuery, scanResidualIntent } from "../routing/tierRouter";
import type { TierDecision } from "../routing/tierRouter";
import { routeIntent } from "../routing/routeIntent";
import type { RouteDecision } from "../routing/routeIntent";
import { DOMAIN_WRITERS, allConverted, composeAck } from '../routing/routeIntent';
import type { IntentRecord } from '../hooks/llmLayers';
import { dispatchRead, dispatchAction } from './chat/dispatch';
import type { DispatchDeps } from './chat/dispatch';
import { handleTier1, buildTier2DeviceContext, buildAmbientDeviceContext, writeProfileFromOnboarding } from "../routing/tier1Responses";
import { refreshCalendarCache } from "../db/calendarCacheDB";
import { markCalendarWrite } from "../db/calendarState";
import { initDB, isDBReady } from "../db/useDeviceDB";
import { getPendingClarification, clearClarification } from "../db/clarificationDB";
import { getDB } from "../db/schema";
import { runMigration } from "../routing/migration";
import { setProfileField, setProfileFields } from "../db/profileDB";
import {
  writeContact,
  resolvePhoneNumber,
  updateLastContact,
  extractContactFromFact,
  findContactByRelationship,
  findContactByName,
  getEmergencyContact,
  setEmergencyContact,
} from "../db/contactsDB";
import { writeMedicalFact, writeMedicalRecord, writeMedication, writeMedicalContact, guessMedicationName, confirmMedicationCapture, deactivateMedicationByName, clearAllMedications, getActiveMedications } from "../db/medicalDB";
import { extractDosage } from "../utils/detectMedicalEvent";
import { drainPendingWrites, getPendingCount, queueWrite } from "../db/pendingWritesDB";
import { _registerContactExtractor, writeFacts, extractFactsLocally, getFactCount, isMedicalCaptureIntent, isMedicationCorroborated, medicalCategoryFromText } from "../db/factDB";
import { getActiveTopics, extractTopicsFromMessage, recordTopicMention } from "../db/topicDB";
import { launchAndroidTimer } from "../utils/androidClock";
import { captureHousehold } from '../utils/householdCapture';
import { answerHouseholdRead, detectHouseholdRead } from '../utils/householdRead';

interface IntentAction {
  type: string;
  value: string;
}

const IDLE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

// ─── Bouncing dots ─────────────────────────────────────────────────────────────

function BouncingDots({ color }: { color: string }) {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  useEffect(() => {
    const animations = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 140),
          Animated.timing(dot, { toValue: -7, duration: 280, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 280, useNativeDriver: true }),
          Animated.delay(420),
        ])
      )
    );
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {dots.map((dot, i) => (
        <Animated.View
          key={i}
          style={{
            width: 9,
            height: 9,
            borderRadius: 5,
            backgroundColor: color,
            transform: [{ translateY: dot }],
            opacity: 0.85,
          }}
        />
      ))}
    </View>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

const THINKING_PHRASES = [
  "Let me find that...",
  "Let me look that up...",
  "Checking on that...",
  "Give me a second...",
  "Working on it...",
  "One moment...",
  "Looking into it...",
  "Hang tight...",
  "Let me think through that...",
];

function extractFact(userMsg: string, aiReply: string, category: string): string | null {
  if (category === 'medication' || category === 'medical') {
    const med = aiReply.match(/Dr\.?\s+\w+|prescribed\s+[\w\s]+|takes\s+[\w\s]+|appointment\s+(?:on\s+)?[\w\s,]+/i);
    if (med) return med[0].trim().slice(0, 100);
  }
  if (category === 'family') {
    const fam = userMsg.match(
      /my\s+(wife|husband|son|daughter|mom|dad|father(?:-in-law)?|mother(?:-in-law)?|brother|sister)(?:'s name is| is named| is)?\s+(\w+)/i
    );
    if (fam) return `${fam[1]}: ${fam[2]}`;
  }
  // All other categories: take first clean sentence of the reply
  const first = aiReply.split(/[.!?]/)[0]?.trim();
  if (first && first.length >= 15 && first.length <= 100) return first;
  return null;
}

function routeDecisionToTier(decision: RouteDecision): TierDecision {
  switch (decision.kind) {
    case 'device_read':
      return {
        tier: 1,
        tier1Response: decision.response,
        llmWrap: decision.llmWrap,
        isMedical: decision.isMedical,
        reason: decision.reason,
      };
    case 'device_action':
      return {
        tier: 1,
        actionIntent: decision.actionIntent,
        reason: decision.reason,
      };
    case 'memory_probe':
      return {
        tier: 2,
        localContext: decision.context,
        reason: decision.reason,
      };
    case 'passthrough':
      return { tier: 3, reason: 'passthrough — unconverted domain' };
    case 'capture':
    case 'backend':
    case 'needs_clarification':
      return { tier: 3, reason: decision.reason };
  }
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const {
    userId,
    name,
    aiName,
    persona: personaKey,
    messages,
    addMessage,
    setMessages,
    setError,
    error,
    items: proactiveItems,
    unreadCount,
    markRead,
    markAllRead,
    isOwner,
    status: freddieStatus,
    localLLMStatus,
  } = useStore();

  const persona = PERSONAS[personaKey] ?? PERSONAS[DEFAULT_PERSONA];

  const { status: llmStatus, activeModel, getCtx, inferLocal } = useLocalLLM();
  void activeModel;

  type ResolveContactFn = (nameOrRelation: string) => Promise<{ phone: string; name: string; contactId?: string } | null>;
  const resolveContactPhoneRef = useRef<ResolveContactFn | null>(null);
  const handleLaunchActionRef = useRef<((appName: string) => Promise<void>) | null>(null);

  const [inputText, setInputText] = useState("");
  const [showProactive, setShowProactive] = useState(false);
  const [pendingAction, setPendingAction] = useState<IntentAction | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus>("confirming");

  const [streamingContent, setStreamingContent] = useState("");
  const [isWaiting, setIsWaiting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingPhrase, setThinkingPhrase] = useState(THINKING_PHRASES[0]);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [dbReady, setDbReady] = useState(false);

  // ── Ambient mode state ────────────────────────────────────────────────────
  // sessionStart filters which messages are shown in the current session.
  // Old messages stay in the store for API context but aren't rendered.
  const [sessionStart, setSessionStart] = useState(() => Date.now());
  const sessionStartRef = useRef(sessionStart);
  const lastInteractionRef = useRef(Date.now());

  const flatListRef = useRef<FlatList>(null);

  const sendingRef = useRef(false);
  const lastSentRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const greetingSentRef = useRef(false);
  const greetingMountRef = useRef(Date.now());
  const needsLocationGreetingRef = useRef(true);
  const liveGreetingAddedRef = useRef(false);
  const greetingIdRef = useRef<string>("");
  const autoOpenAppsRef = useRef<Set<string>>(new Set());
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const tokenBatchRef = useRef<string>('');
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTodoCompleteRef = useRef<{ id: string; body: string } | null>(null);
  // Pending contact collection — when Herald asks "what's their number/address?"
  // the next user message resolves this and executes the original intent.
  const pendingContactCollectRef = useRef<{ action: 'call' | 'navigate' | 'text' | 'confirm_phone'; name: string; body?: string } | null>(null);
  const pendingMedConfirmRef = useRef<{ category: 'medication' | 'medical' | 'visit'; value: string; guessedName: string; guessedDosage?: string } | null>(null);
  const pendingMedClearRef = useRef<{ count: number } | null>(null);
  const pendingInsuranceRef = useRef<{ type: string; carrier: string; ack: string } | null>(null);
  const pendingFamilyRef = useRef<{ name: string; relationship: string; location?: string } | null>(null);
  const pendingResumeRef = useRef<{
    pendingKey: string;
    resume: (t: string) => Promise<import('../routing/routeIntent').CommitResult>;
  } | null>(null);

  // ── Scroll snap prevention ────────────────────────────────────────────────
  // Only auto-scroll to bottom when user is already near the bottom.
  // If they've scrolled up to read (Freddie response etc.), leave them there.
  const isAtBottomRef = useRef(true);

  const { speak, enqueueSentence, resetSpeech, stop, isSpeaking } = useSpeech();
  const [handsFreeMode, setHandsFreeMode] = useState(false);
  const handsFreeRef = useRef(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useProactiveQueue();
  useCalendar();
  const { lat, lng, label: locationLabel, available } = useLocation();
  const {
    saveMemory: saveDeviceMemory,
    saveProfile: saveDeviceProfile,
    getLocalGreeting,
    getContextBlock,
  } = useDeviceMemory();

  // ── Filter messages for display (current session only) ───────────────────
  const displayMessages = useMemo(
    () => messages.filter((m) => m.timestamp >= sessionStart),
    [messages, sessionStart]
  );

  // ── Idle resume handler ref (always fresh closure) ───────────────────────
  const handleIdleResumeRef = useRef<() => void>(() => {});
  useEffect(() => {
    handleIdleResumeRef.current = () => {
      // Only fire idle greeting if user has actually been active (has messages)
      // Prevents double greeting on first install / onboarding completion
      const currentMessages = useStore.getState().messages;
      if (currentMessages.length === 0) return;
      liveGreetingAddedRef.current = false;
      const newSessionStart = Date.now();
      setSessionStart(newSessionStart);
      sessionStartRef.current = newSessionStart;
      // Scroll back to bottom for fresh session
      isAtBottomRef.current = true;
      if (!userId) return;
      const local_time = new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      fetchGreeting({
        user_id: userId,
        local_time,
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        location_label: locationLabel ?? undefined,
      })
        .then((data) => {
          if (!data.greeting) return;
          if (liveGreetingAddedRef.current) return;
          liveGreetingAddedRef.current = true;
          addMessage({
            id: generateId("msg"),
            role: "assistant",
            content: data.greeting,
            timestamp: newSessionStart + 10, // ensure it's inside new session window
          });
          speak(data.greeting);
        })
        .catch(() => {});
    };
  }, [userId, lat, lng, locationLabel, addMessage, speak]);

  const resetStreamState = useCallback(() => {
    sendingRef.current = false;
    setIsWaiting(false);
    setIsStreaming(false);
    setStreamingContent("");
    tokenBatchRef.current = '';
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if ((streamAbortRef.current as any)?._maxTimer) {
      clearTimeout((streamAbortRef.current as any)._maxTimer);
    }
    streamAbortRef.current = null;
  }, []);

  // ── AppState listener (stable, uses ref) ──────────────────────────────────
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (nextState === "background" || nextState === "inactive") {
          if (streamAbortRef.current) {
            streamAbortRef.current.abort();
            resetStreamState();
          }
          // Write session summary to SQLite on background
          void (async () => {
            try {
              const sessionMessages = useStore.getState().messages.filter(
                (m) => m.timestamp >= sessionStartRef.current
              );
              if (sessionMessages.length >= 2) {
                const summary = sessionMessages
                  .slice(-10)
                  .map((m) => `${m.role === 'user' ? 'User' : 'Herald'}: ${m.content.slice(0, 200)}`)
                  .join('\n');
                const { writeSessionSummary } = await import('../db/sessionDB');
                writeSessionSummary(summary);
              }
            } catch {}
          })();
        }
        if (nextState === "active") {
          const idleMs = Date.now() - lastInteractionRef.current;
          if (idleMs > IDLE_THRESHOLD_MS) {
            handleIdleResumeRef.current();
          }
          refreshCalendarCache().catch(() => {}); // refresh cache on foreground
          // Drain offline queue on foreground — catches writes queued while offline
          Network.getNetworkStateAsync().then((net) => {
            if (!net.isConnected || !net.isInternetReachable) return;
            if (getPendingCount() === 0) return;
            drainPendingWrites(async (write) => {
              const payload = JSON.parse(write.payload);
              if (write.type === 'calendar') {
                await handleCalendarAction(payload.value);
              }
            }).catch(() => {});
          }).catch(() => {});
        }
        // Always update on any state change (background, inactive, active)
        lastInteractionRef.current = Date.now();
      }
    );
    return () => subscription.remove();
  }, []); // stable -- no deps needed

  useEffect(() => {
    return () => {
      if (streamAbortRef.current) {
        streamAbortRef.current.abort();
        resetStreamState();
      }
    };
  }, [resetStreamState]);

  useEffect(() => {
    if (unreadCount > 0) setShowProactive(true);
  }, [unreadCount]);

  useEffect(() => {
    AsyncStorage.getItem('herald_auto_open_apps').then(val => {
      if (val) {
        try {
          const saved = JSON.parse(val);
          if (Array.isArray(saved)) {
            autoOpenAppsRef.current = new Set(saved);
          }
        } catch {}
      }
    });
  }, []);

  // Startup-settled beacon: fires ~6s after mount, PAST the window the old
  // build crashed in (native llama.rn init). Its arrival on Railway = the
  // startup danger window was survived. Its absence = something in startup
  // (mic listener / calendar) is still killing the process.
  useEffect(() => {
    const t = setTimeout(() => beacon('startup_settled'), 6000);
    return () => clearTimeout(t);
  }, []);

  // ── Session L: init device SQLite and run one-time migration ─────────────
  useEffect(() => {
    if (!userId) return;
    beacon('chat_mounted');
    initDB().then(async () => {
      try {
        await runMigration(userId);
      } catch {}

      try {
        await refreshCalendarCache();
      } catch {}

      try {
        _registerContactExtractor(extractContactFromFact);
      } catch {}

      // Pre-request READ_CONTACTS permission at startup so resolveContactPhone
      // never triggers a mid-conversation permission dialog.
      try {
        const Contacts = await import('expo-contacts');
        await Contacts.requestPermissionsAsync();
      } catch {}

      // Wire core identity to local_profile SQLite table
      try {
        const store = useStore.getState();
        const profileWrites: Record<string, string> = {};
        if (store.name)    profileWrites.name    = store.name;
        if (store.aiName)  profileWrites.ai_name = store.aiName;
        if (store.persona) profileWrites.persona  = store.persona;
        if (userId)        profileWrites.user_id  = userId;
        if (Object.keys(profileWrites).length > 0) {
          setProfileFields(profileWrites);
        }
      } catch {}

      setDbReady(true);
      beacon('chat_db_ready');

      // Drain any writes queued while offline — calendar events, SMS etc.
      try {
        const pending = getPendingCount();
        if (pending > 0) {
          drainPendingWrites(async (write) => {
            const payload = JSON.parse(write.payload);
            if (write.type === 'calendar') {
              await handleCalendarAction(payload.value);
            }
            // SMS drain: open native messages — non-blocking best effort
            if (write.type === 'sms') {
              const { Linking } = await import('react-native');
              const body = encodeURIComponent(payload.body ?? '');
              const num  = payload.phone ?? '';
              await Linking.openURL(num
                ? `sms:${num}?body=${body}`
                : `sms:?body=${body}`
              );
            }
          }).then((drained) => {
            if (drained > 0) {
              addMessage({
                id: generateId('msg'),
                role: 'assistant',
                content: `I went ahead and took care of ${drained} thing${drained > 1 ? 's' : ''} I had queued up while you were offline.`,
                timestamp: Date.now(),
              });
            }
          }).catch(() => {});
        }
      } catch {}
    }).catch(() => {
      setDbReady(true);
    });
  }, [userId]);

  useEffect(() => {
    if (!userId || !name || !dbReady) return;
    setProfileField('name', name);
  }, [userId, name, dbReady]);

  useEffect(() => {
    if (!isWaiting) return;
    let index = 0;
    const interval = setInterval(() => {
      index = (index + 1) % THINKING_PHRASES.length;
      setThinkingPhrase(THINKING_PHRASES[index]);
    }, 4000);
    return () => clearInterval(interval);
  }, [isWaiting]);

  const upgradeLiveGreeting = useCallback(
    (greetingLat?: number, greetingLng?: number, greetingLabel?: string) => {
      const local_time = new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return fetchGreeting({
        user_id: userId,
        local_time,
        lat: greetingLat ?? undefined,
        lng: greetingLng ?? undefined,
        location_label: greetingLabel ?? undefined,
      })
        .then((data) => {
          if (!data.greeting) return;
          const hasWeather = /degrees|weather|forecast/i.test(data.greeting);
          if (hasWeather) {
            if (liveGreetingAddedRef.current) return;
            liveGreetingAddedRef.current = true;
            setMessages(
              useStore.getState().messages.filter((m) => m.id !== greetingIdRef.current)
            );
            addMessage({
              id: generateId("msg"),
              role: "assistant",
              content: data.greeting,
              timestamp: Date.now() + 1,
            });
            beacon('greeting_weather_rendered');
          }
        })
        .catch(() => {});
    },
    [userId, addMessage, setMessages]
  );

  // ── Greeting on first open ────────────────────────────────────────────────
  // Use displayMessages not messages -- old sessions have messages.length > 0
  // but displayMessages is always empty on mount (sessionStart = Date.now()).
  useEffect(() => {
    if (!userId || !dbReady || displayMessages.length > 0) return;
    if (greetingSentRef.current) return;
    greetingSentRef.current = true;

    if (lat != null && lng != null) {
      needsLocationGreetingRef.current = false;
    }

    // ── INSTANT LOCAL GREETING (device-first, under 500ms) ───────────────────
    const localGreeting = getLocalGreeting(aiName || "Herald");
    const greetingId = generateId("msg");
    greetingIdRef.current = greetingId;
    addMessage({
      id: greetingId,
      role: "assistant",
      content: localGreeting,
      timestamp: Date.now(),
    });
    speak(localGreeting);

    // ── BACKGROUND LIVE ENHANCEMENT ──────────────────────────────────────────
    upgradeLiveGreeting(lat ?? undefined, lng ?? undefined, locationLabel ?? undefined);
  }, [userId, dbReady, available, lat, lng, locationLabel, displayMessages.length, getLocalGreeting, aiName, addMessage, speak, upgradeLiveGreeting]);

  // If GPS resolves within 3s of open, re-fetch greeting with real coords.
  useEffect(() => {
    if (!userId || !available || lat == null || lng == null) return;
    if (!greetingSentRef.current) return;
    if (Date.now() - greetingMountRef.current > 3000) return;
    if (!needsLocationGreetingRef.current) return;
    needsLocationGreetingRef.current = false;
    upgradeLiveGreeting(lat, lng, locationLabel ?? undefined);
  }, [userId, available, lat, lng, locationLabel, upgradeLiveGreeting]);

  // Silent profile location update when GPS becomes available.
  useEffect(() => {
    if (!available || !userId || lat == null || lng == null) return;
    const geocodeController = new AbortController();
    const geocodeTimer = setTimeout(() => geocodeController.abort(), 8000);
    fetch(`${API_BASE}/geocode?lat=${lat}&lng=${lng}&user_id=${userId}`, {
      signal: geocodeController.signal,
    })
      .then(() => clearTimeout(geocodeTimer))
      .catch(() => clearTimeout(geocodeTimer));
    return () => {
      geocodeController.abort();
      clearTimeout(geocodeTimer);
    };
  }, [available, userId, lat, lng]);

  // ── Auto-scroll (only when user is at bottom) ─────────────────────────────
  useEffect(() => {
    if ((displayMessages.length > 0 || streamingContent) && isAtBottomRef.current) {
      flatListRef.current?.scrollToEnd({ animated: false });
    }
  }, [displayMessages.length, streamingContent]);

  function getKnownContactNames(): string[] {
    try {
      const db = getDB();
      const rows = db.getAllSync<{ name: string }>(
        `SELECT DISTINCT name FROM contacts WHERE removed_at IS NULL LIMIT 20`,
      );
      return rows.map((r) => r.name.split(' ')[0]);
    } catch {
      return [];
    }
  }

  function getKnownListNames(): string[] {
    try {
      const db = getDB();
      const rows = db.getAllSync<{ name: string }>(
        `SELECT name FROM lists`,
      );
      return rows.map((r) => r.name);
    } catch {
      return ['grocery', 'todo'];
    }
  }

  const dispatchLocalIntent = useCallback(async (
    intent: Record<string, string | undefined>,
    originalText: string,
  ): Promise<boolean> => {
    const replyAndReset = (msg: string) => {
      addMessage({ id: generateId('msg'), role: 'assistant',
        content: msg, timestamp: Date.now() });
      speak(msg);
      sendingRef.current = false;
      setInputText('');
    };
    try {
      const db = getDB();
      switch (intent.type) {
        case 'list_remove': {
          const matches = db.getAllSync<{ id: string; body: string }>(
            `SELECT li.id, li.body FROM list_items li
             JOIN lists l ON l.id = li.list_id
             WHERE l.name = ? AND li.checked = 0
             AND lower(li.body) LIKE lower(?)`,
            [intent.listName ?? 'grocery', `%${intent.item ?? ''}%`],
          );
          if (matches.length === 0) {
            replyAndReset(`I don't see ${intent.item} on your list.`);
          } else if (matches.length === 1) {
            db.runSync(`UPDATE list_items SET checked = 1 WHERE id = ?`,
              [matches[0].id]);
            replyAndReset(`Removed ${matches[0].body} from your ${intent.listName ?? 'grocery'} list.`);
          } else {
            replyAndReset(`I see a few matches — which one did you mean?`);
          }
          return true;
        }
        case 'call': {
          const contactName = intent.contact ?? '';
          const resolved = await resolveContactPhoneRef.current?.(contactName);
          if (resolved?.phone) {
            await Linking.openURL(`tel:${resolved.phone.replace(/\D/g, '')}`);
            replyAndReset(`Calling ${resolved.name}.`);
          } else {
            replyAndReset(`I don't have a number for ${contactName}. What's their number?`);
            pendingContactCollectRef.current = { action: 'call', name: contactName };
          }
          return true;
        }
        case 'household_read': {
          const householdIntent = detectHouseholdRead(originalText);
          if (householdIntent) {
            replyAndReset(answerHouseholdRead(householdIntent));
          } else {
            replyAndReset(`I'm not sure I caught that — were you telling me something to remember, or asking me to look something up?`);
          }
          return true;
        }
        case 'photo_open': {
          let opened = false;
          if (Platform.OS === 'android') {
            const photoIntents = [
              'intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.google.android.apps.photos;end',
              'intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.sec.android.gallery3d;end',
              'googlephotos://',
            ];
            for (const uri of photoIntents) {
              try {
                await Linking.openURL(uri);
                opened = true;
                break;
              } catch { /* try next */ }
            }
          }
          replyAndReset(opened
            ? `Opening your photos.`
            : `I couldn't open your gallery — try opening Photos manually.`);
          return true;
        }
        case 'app_open': {
          const appName = intent.appName ?? 'app';
          try {
            await handleLaunchActionRef.current?.(appName);
            replyAndReset(`Opening ${appName}.`);
          } catch {
            replyAndReset(`I couldn't open ${appName} — try opening it manually.`);
          }
          return true;
        }
        case 'insurance_capture': {
          const { type, insType, carrier, agent, phone } = intent as {
            type: 'insurance_capture'; insType: string; carrier: string;
            agent?: string; phone?: string;
          };
          void agent;
          void phone;
          // Guard against the on-device model echoing schema names or placeholders
          // into data fields instead of real values. Deterministic floor — never
          // speak a garbage carrier/type to the user; ask a clean question instead.
          const BAD = /^(unknown|insurance_capture|insurance|none|null|n\/a)$/i;
          const cleanCarrier = (carrier ?? '').trim();
          const cleanType = (insType ?? '').trim();
          const carrierOk = cleanCarrier.length >= 2 && !BAD.test(cleanCarrier);
          const typeOk = cleanType.length >= 2 && !BAD.test(cleanType);
          if (!carrierOk) {
            addMessage({ id: generateId('msg'), role: 'user', content: originalText, timestamp: Date.now() });
            replyAndReset(`I didn't quite catch that — who's your insurance with?`);
            return true;
          }
          const spokenType = typeOk ? cleanType : 'insurance';
          const ack = typeOk
            ? `Got it — ${cleanCarrier} for your ${spokenType} insurance, right?`
            : `Got it — ${cleanCarrier} insurance, right?`;
          pendingInsuranceRef.current = { type: cleanType || 'unknown', carrier: cleanCarrier, ack };
          addMessage({ id: generateId('msg'), role: 'user', content: originalText, timestamp: Date.now() });
          replyAndReset(ack);
          return true;
        }
        case 'family_capture': {
          const { relation, name: famName, location } = intent as {
            type: 'family_capture'; relation: string; name: string; location?: string;
          };

          const PLACEHOLDER_NAMES = new Set(['unknown','unnamed','none','n/a','someone','somebody','that','this','it','he','she','they','him','her','them']);
          const isRealName = (v: string) => v && v.trim().length >= 2 && !PLACEHOLDER_NAMES.has(v.trim().toLowerCase());

          if (!relation?.trim() || !isRealName(famName)) {
            sendingRef.current = false;
            replyAndReset(`I didn't catch the name — who is your ${relation || 'family member'}?`);
            return true;
          }

          pendingFamilyRef.current = { name: famName, relationship: relation, location };
          const reply = location
            ? `${famName}, your ${relation}, in ${location} — that right?`
            : `${famName}, your ${relation} — that right?`;

          setPendingAction({ type: 'family', value: reply });
          setActionStatus('confirming');
          sendingRef.current = false;
          return true;
        }
        case 'medical_capture': {
          // Medical capture from LLM — route through existing confirm gate
          // Never write directly from LLM — goes through pendingMedConfirmRef
          const { drug, raw } = intent as {
            type: 'medical_capture'; drug?: string; raw: string;
          };
          const guessedName = drug ?? guessMedicationName(raw);
          if (!guessedName || guessedName.length < 2) {
            sendingRef.current = false;
            replyAndReset("Which medication did you want me to note?");
            return true;
          }
          const guessedDosage = extractDosage(raw);
          pendingMedConfirmRef.current = {
            category: 'medication',
            value: raw,
            guessedName,
            guessedDosage,
          };
          replyAndReset(
            guessedDosage
              ? `Want me to remember ${guessedName}, ${guessedDosage}, as a medication?`
              : `Want me to remember ${guessedName} as a medication?`
          );
          return true;
        }
        default:
          replyAndReset(`I couldn't quite get that — try a different way.`);
          return true;
      }
    } catch {
      replyAndReset(`Sorry, I couldn't do that right now.`);
      return false;
    }
  }, [addMessage, speak, setInputText, setPendingAction, setActionStatus]);

  // ── Send ──────────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (text: string) => {
    const now = Date.now();
    if (now - lastSentRef.current < 1000) return;
    if (sendingRef.current) return;
    if (!text) return;

    // ── Input front door ─────────────────────────────────────────────────────
    // Normalize once, here, before ANY logic (capture, routing, display) touches
    // the message. Makes input device-agnostic — curly quotes, unicode dashes/
    // spaces from any keyboard or speech engine are folded to a canonical form so
    // nothing downstream has to care which device produced the text.
    text = normalizeInput(text);
    if (!text) return;

    lastSentRef.current = now;
    sendingRef.current = true;
    try {
    const historySnapshot = messages.slice(-20).map(({ role, content }) => ({ role, content }));

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Auto-open triggers removed — per-app permission is now set
    // automatically when the user confirms a launch intent.
    // "just open it" style phrases are no longer needed.

    // ── Tier router — device-first before any network call ───────────────────
    if (!isDBReady()) {
      try {
        await initDB();
      } catch {}
    }

    const pending = getPendingClarification();
    if (pending) {
      const looksLikeQuestion = /\b(am i|do i|do you|what|who|when|where|how|is there|are there|have you|can you)\b/i.test(text.trim());
      const looksLikeNewIntent = /\b(remind me|set a|add|note that|what's on|show me|call|text)\b/i.test(text.trim());
      if (!looksLikeQuestion && !looksLikeNewIntent) {
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        let reply: string;
        try {
          const db = getDB();
          if (pending.slot === 'doctor_name') {
            db.runSync('UPDATE medical_records SET doctor_name = ? WHERE id = ?', [text.trim(), pending.record_id]);
          } else if (pending.slot === 'dosage') {
            const dosageMatch = text.match(/(\d+\s*(?:mg|mcg|ml|g|units?|tablets?|pills?|drops?|puffs?))/i);
            const dosageValue = dosageMatch ? dosageMatch[1].trim() : text.trim();
            db.runSync('UPDATE medications SET dosage = ? WHERE id = ?', [dosageValue, pending.record_id]);
          } else if (pending.slot === 'drug_name') {
            db.runSync('UPDATE medications SET name = ? WHERE id = ?', [text.trim(), pending.record_id]);
          }
          reply = "Got it — I've got that.";
        } catch {
          reply = "I couldn't hold onto that just now — want to try again?";
        }
        clearClarification(pending.id);
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        setInputText('');
        sendingRef.current = false;
        return;
      }
      clearClarification(pending.id);
    }

    // Pending todo completion confirm — check before routing
    const YES = /^(yes|yeah|yep|correct|right|10-4)\b/i;
    const NO = /^(no|nope|not yet|negative)\b/i;
    if (pendingTodoCompleteRef.current) {
      const pending = pendingTodoCompleteRef.current;
      if (YES.test(text.trim())) {
        pendingTodoCompleteRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        try {
          const { getDB } = await import('../db/schema');
          const db = getDB();
          db.runSync(
            `UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ?;`,
            [new Date().toISOString(), pending.id]
          );
          const reply = `Done — crossed off '${pending.body}'.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        } catch {
          const reply = `Couldn't update that. Try again.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        }
        sendingRef.current = false;
        setInputText('');
        return;
      }
      if (NO.test(text.trim())) {
        pendingTodoCompleteRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        const reply = `Got it — leaving '${pending.body}' on your list.`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      // Not a yes/no — clear pending and fall through to normal routing
      pendingTodoCompleteRef.current = null;
    }

    // ── Pending continuation — user is answering a question a writer asked ──
    if (pendingResumeRef.current) {
      const { resume } = pendingResumeRef.current;
      pendingResumeRef.current = null;
      const result = await resume(text);
      if (result.status === 'noop' && !result.ack) {
        // Not an answer to the pending question — let it route normally below.
        // (Do not echo here; the normal path adds its own user bubble.)
      } else {
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        const ack = composeAck([result]);
        addMessage({ id: generateId('msg'), role: 'assistant', content: ack, timestamp: Date.now() });
        speak(ack);
        if (result.status === 'pending') {
          pendingResumeRef.current = { pendingKey: result.pendingKey, resume: result.resume };
        }
        sendingRef.current = false;
        setInputText('');
        return;
      }
    }

    // ── Pending medication confirm (Build A — Option B) ──
    if (pendingMedConfirmRef.current) {
      const pendingMed = pendingMedConfirmRef.current;
      if (YES.test(text.trim())) {
        pendingMedConfirmRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        let result: { id: string; action: 'created' | 'superseded'; previousId?: string } | null = null;
        try {
          if (pendingMed.category === 'medication') {
            // Write EXACTLY what was confirmed — never re-derive from raw
            // text at commit time (verbatim rule, Spine §3).
            result = confirmMedicationCapture(pendingMed.guessedName, pendingMed.guessedDosage, pendingMed.value);
          } else {
            writeMedicalFact(pendingMed.category, pendingMed.value);
          }
        } catch (err) {
          console.error('[Herald] medication confirm write failed:', err);
        }
        let reply: string;
        if (pendingMed.category === 'medication') {
          if (result?.action === 'superseded') {
            reply = pendingMed.guessedDosage
              ? `Got it — updated your ${pendingMed.guessedName} to ${pendingMed.guessedDosage}.`
              : `Got it — updated your ${pendingMed.guessedName}.`;
          } else if (result?.action === 'created') {
            reply = pendingMed.guessedDosage
              ? `Got it — I'll remember ${pendingMed.guessedName}, ${pendingMed.guessedDosage}, with your medications.`
              : `Got it — I'll remember ${pendingMed.guessedName} with your medications.`;
          } else {
            reply = `I'm having trouble holding onto that one — let's try again in a moment.`;
          }
        } else {
          reply = pendingMed.guessedDosage
            ? `Got it — I'll remember ${pendingMed.guessedName}, ${pendingMed.guessedDosage}, with your medications.`
            : `Got it — I'll remember ${pendingMed.guessedName} with your medications.`;
        }
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      if (NO.test(text.trim())) {
        pendingMedConfirmRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        const reply = `No problem — I won't add that.`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      // Not a yes/no — discard the pending confirm and fall through (fail toward not writing)
      pendingMedConfirmRef.current = null;
    }

    // ── Pending medication CLEAR confirm (Build A — destructive, soft-delete) ──
    if (pendingMedClearRef.current) {
      if (YES.test(text.trim())) {
        pendingMedClearRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        let removed = 0;
        try { removed = clearAllMedications(); } catch {}
        const reply = removed > 0
          ? `Done — cleared ${removed} ${removed === 1 ? 'medication' : 'medications'}. You can start fresh anytime.`
          : `There were no active medications to clear.`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      if (NO.test(text.trim())) {
        pendingMedClearRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        const reply = `Okay — I left your medications as they are.`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      // Not a yes/no — cancel the clear (fail safe: never wipe on ambiguity)
      pendingMedClearRef.current = null;
    }

    // ── Pending contact collection — user is providing a number or address ──
    if (pendingContactCollectRef.current) {
      const pending = pendingContactCollectRef.current;
      const phoneMatch = text.match(/([\d\s\-\(\)\+\.]{7,})/);
      const isLikelyAddress = text.length > 8 && /\d/.test(text) && /\b(st|ave|blvd|rd|dr|ln|way|ct|pl|circle|drive|street|road|court|lane|avenue)\b/i.test(text);

      // Re-validating a phone number Herald couldn't trust earlier (misheard digit
      // count). Stay in this mode until we get a clean 10-digit number — never store
      // a malformed one.
      if (pending.action === 'confirm_phone') {
        const reCheck = phoneMatch ? normalizePhone(phoneMatch[1]) : null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        if (reCheck?.valid) {
          pendingContactCollectRef.current = null;
          try {
            const { capturePerson } = await import('../db/capturePerson');
            const existing = findContactByRelationship(pending.name) ?? findContactByName(pending.name);
            // Reachability only — no relationship passed (avoids fabricating
            // "name is my name"; COALESCE keeps any real relationship). [Spine §4a]
            capturePerson({ name: existing?.name ?? pending.name, phone: reCheck.normalized, importance: existing?.importance ?? 7 });
            const reply = `Perfect — I've got ${pending.name}'s number as ${reCheck.spoken}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `I had trouble holding onto that — let's try once more. What's ${pending.name}'s number?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
        } else {
          const heard = reCheck ? reCheck.spoken : text.trim();
          const reply = `I still didn't catch a full 10-digit number — I heard ${heard}. Can you say ${pending.name}'s number again, slowly?`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        }
        sendingRef.current = false;
        setInputText('');
        return;
      }

      if (pending.action === 'call' && phoneMatch) {
        const phone = phoneMatch[1].replace(/\D/g, '');
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        pendingContactCollectRef.current = null;
        try {
          const { capturePerson } = await import('../db/capturePerson');
          const existing = findContactByRelationship(pending.name) ?? findContactByName(pending.name);
          // Reachability only — no relationship passed. [Spine §4a]
          capturePerson({ name: existing?.name ?? pending.name, phone, importance: existing?.importance ?? 7 });
          await Linking.openURL(`tel:${phone}`);
          const reply = `Got it — calling ${pending.name} now.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        } catch {
          const reply = `I've got the number, but couldn't open the dialer. Try calling ${pending.name} manually.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        }
        sendingRef.current = false;
        setInputText('');
        return;
      }

      // Accept as address: has a digit AND is longer than 5 chars.
      // Drops the street-suffix regex that rejected real addresses like
      // "123 Oak" or "4500 Main" without a spelled-out suffix.
      const isLikelyAddressLoose = /\d/.test(text) && text.trim().length > 5;
      if (pending.action === 'navigate' && isLikelyAddressLoose) {
        const address = text.trim().replace(/[.!?]+$/, '');
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        pendingContactCollectRef.current = null;
        try {
          const { capturePerson } = await import('../db/capturePerson');
          const existing = findContactByRelationship(pending.name) ?? findContactByName(pending.name);
          // Reachability only — no relationship passed. [Spine §4a]
          capturePerson({ name: existing?.name ?? pending.name, address, importance: existing?.importance ?? 6 });
          await handleMapsAction(address);
          const reply = `Got it — opening directions to ${pending.name}.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        } catch {
          const reply = `Got the address. Try asking for directions again.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        }
        sendingRef.current = false;
        setInputText('');
        return;
      }

      if (pending.action === 'text' && phoneMatch) {
        const phone = phoneMatch[1].replace(/\D/g, '');
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        pendingContactCollectRef.current = null;
        try {
          const { capturePerson } = await import('../db/capturePerson');
          const existing = findContactByRelationship(pending.name) ?? findContactByName(pending.name);
          // Reachability only — no relationship passed. [Spine §4a]
          capturePerson({ name: existing?.name ?? pending.name, phone, importance: existing?.importance ?? 7 });
          const smsUrl = pending.body
            ? `sms:${phone}?body=${encodeURIComponent(pending.body)}`
            : `sms:${phone}`;
          await Linking.openURL(smsUrl);
          const reply = pending.body
            ? `Got it — opening a message to ${pending.name} with your note ready.`
            : `Got it — opening a message to ${pending.name}.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        } catch {
          const reply = `Got the number. Try texting ${pending.name} again.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
        }
        sendingRef.current = false;
        setInputText('');
        return;
      }

      // Looks like they changed their mind or said something unrelated
      pendingContactCollectRef.current = null;
      // Fall through to normal routing
    }

    // Deterministic-first routing: the regex/SQL classifier runs FIRST and always wins.
    // Tier-1 reads and actions are handled by the dispatch below. The on-device LLM only
    // attempts a capture when deterministic routing found nothing actionable (tier 3 gap).
    const routeDecision = await routeIntent(text, {
      classifyQuery,
      classifyLLM: async (t: string) => classifyWithLLM(t, getCtx(), {
        contacts: getKnownContactNames(),
        lists: getKnownListNames(),
        name: undefined,
      }),
      llmReady: llmStatus === 'ready',
    });
    const tierDecision = routeDecisionToTier(routeDecision);

    // Runs converted intents through their domain writers, speaks the verified
    // ACK, clears the send lock. Single dispatch site for all three paths.
    const applyConvertedIntents = async (
      convIntents: IntentRecord[],
      rawText: string,
      opts?: { echoUser?: boolean },
    ): Promise<void> => {
      const results: import('../routing/routeIntent').CommitResult[] = [];
      for (const intent of convIntents) {
        const writer = DOMAIN_WRITERS[intent.type];
        if (writer) results.push(await writer.add(intent, rawText));
      }
      const ack = composeAck(results);
      if (opts?.echoUser) {
        addMessage({ id: generateId('msg'), role: 'user', content: rawText, timestamp: Date.now() });
      }
      addMessage({ id: generateId('msg'), role: 'assistant', content: ack, timestamp: Date.now() });
      speak(ack);
      const pending = results.find(r => r.status === 'pending');
      if (pending && pending.status === 'pending') {
        pendingResumeRef.current = { pendingKey: pending.pendingKey, resume: pending.resume };
      }
      sendingRef.current = false;
      setInputText('');
    };

    // ── Routing authority dispatch (Commit 3) ────────────────────────────────
    // If routeIntent returned a capture decision AND every intent type has a
    // registered domain writer, dispatch through the authority and return.
    // Legacy islands handle everything else (passthrough or unconverted domains).
    if (
      routeDecision.kind === 'capture' &&
      allConverted(routeDecision.intents)
    ) {
      await applyConvertedIntents(routeDecision.intents, text);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // LLM capture — fallback classifier for the ambiguous tier-3 gap ONLY.
    if (llmStatus === 'ready' && tierDecision.tier === 3) {
      try {
        const llmCaptures = await classifyWithLLM(text, getCtx(), {
          contacts: getKnownContactNames(),
          lists: getKnownListNames(),
          name: undefined,
        });
        if (llmCaptures.length > 0) {
          if (allConverted(llmCaptures)) {
            await applyConvertedIntents(llmCaptures, text, { echoUser: true });
            return;
          }
          const handled = await dispatchLocalIntent(
            llmCaptures[0] as Record<string, string | undefined>,
            text,
          );
          if (handled) {
            sendingRef.current = false;
            setInputText('');
            return;
          }
        }
      } catch {
        // LLM failed — fall through to regex classifyQuery
      }
    }

    // ── Offline check -- skip network, answer from device or give warm message ──
    const networkState = await Network.getNetworkStateAsync();
    let localFactsWritten = false;
    const isTier1Read = tierDecision.tier === 1 && !!tierDecision.tier1Response;

    // Phone capture runs unconditionally — dual-intent sentences need both phone + medical
    const SERVICE_CATEGORY_WORDS = new Set([
      'plumber','electrician','hvac','ac','air conditioning','heating',
      'roofer','handyman','contractor','painter','landscaper','lawn',
      'pest control','exterminator','cleaner','housekeeper','pool',
      'mechanic','vet','veterinarian','accountant','lawyer','attorney',
      'financial advisor','insurance agent'
    ]);
    const phoneCapture1 = text.match(
      /\bmy ([\w]+(?:\s+[\w]+)?)'?s?\s+(?:number|phone|cell|mobile)\s+(?:is\s+)?([\d\s\-\(\)\+\.]{7,})/i
    );
    const phoneCapture2 = text.match(
      /\bmy (?:friend|buddy|brother|sister|son|daughter|wife|husband|mom|dad|neighbor|doctor|pharmacy)\s+([\w]+)\s+(?:his|her|their)?\s*(?:phone\s+)?(?:number|phone|cell|mobile)\s+(?:is\s+)?([\d\s\-\(\)\+\.]{7,})/i
    );
    const phoneCapture3 = text.match(
      /([\w]+)'s\s+(?:phone\s+)?(?:number|phone|cell|mobile)\s+(?:is\s+)?([\d\s\-\(\)\+\.]{7,})/i
    );
    const relationMatch = text.match(/\bmy (friend|buddy|brother|sister|son|daughter|wife|husband|mom|dad|neighbor|doctor|pharmacy)\b/i);
    const captureRelationship = relationMatch ? relationMatch[1].trim().toLowerCase() : null;

    let captureName: string | null = null;
    let capturePhone: string | null = null;

    if (phoneCapture2) {
      captureName = phoneCapture2[1].trim().toLowerCase();
      capturePhone = phoneCapture2[2].replace(/\D/g, '');
    } else if (phoneCapture3) {
      captureName = phoneCapture3[1].trim().toLowerCase();
      capturePhone = phoneCapture3[2].replace(/\D/g, '');
    } else if (phoneCapture1) {
      captureName = phoneCapture1[1].trim().toLowerCase();
      capturePhone = phoneCapture1[2].replace(/\D/g, '');
    }

    if (captureName && SERVICE_CATEGORY_WORDS.has(captureName.trim().toLowerCase())) {
      captureName = null;
      capturePhone = null;
    }

    if (captureName && capturePhone && capturePhone.length >= 7) {
      const phoneCheck = normalizePhone(capturePhone);
      try {
        const { findContactByRelationship, findContactByName } = await import('../db/contactsDB');
        const { capturePerson } = await import('../db/capturePerson');
        const existing = findContactByRelationship(captureName) || findContactByName(captureName);
        localFactsWritten = true;

        if (phoneCheck.valid) {
          // Clean 10-digit number — store the normalized form.
          capturePerson({
            name: existing?.name ?? captureName,
            relationship: existing?.relationship ?? captureRelationship ?? undefined,
            phone: phoneCheck.normalized,
            importance: existing?.importance,
          });
        } else {
          // Misheard digit count — do NOT store the bad number. Save the person,
          // read back what was heard, and ask for the number again. The pending
          // state lets the next reply (even bare digits) attach to this contact.
          capturePerson({
            name: existing?.name ?? captureName,
            relationship: existing?.relationship ?? captureRelationship ?? undefined,
            importance: existing?.importance,
          });
          pendingContactCollectRef.current = { action: 'confirm_phone', name: captureName };
          const issueWord = phoneCheck.issue === 'long' ? 'a couple of digits too many' : 'a bit short';
          const ask = `I heard ${captureName}'s number as ${phoneCheck.spoken}, but that looks like ${issueWord}. Can you say it again for me?`;
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          addMessage({ id: generateId('msg'), role: 'assistant', content: ask, timestamp: Date.now() });
          speak(ask);
          sendingRef.current = false;
          setInputText('');
          return;
        }
      } catch (e) { console.warn('phoneCapture write failed:', e); }
    }

    // Address capture — runs before extractFactsLocally (same rule as phone capture)
    const ADDRESS_PATTERNS = [
      /\bmy ([\w\s\-']+?)'?s?\s+(?:address|house|place|home)\s+is\s+(.+)/i,
      /\b([\w\s\-']+?)\s+(?:lives?|is located)\s+at\s+(.+)/i,
      /\bthe ([\w\s\-']+?)\s+is\s+(?:at|located at)\s+(.+)/i,
      /\b([\w\s\-']+?)'?s?\s+(?:address|place)\s+is\s+(.+)/i,
    ];

    for (const pattern of ADDRESS_PATTERNS) {
      const m = text.match(pattern);
      if (m) {
        const whoRaw = m[1].trim().toLowerCase().replace(/^my\s+/i, '');
        const addressRaw = m[2].trim()
          .replace(/[.!?]+$/, '')
          .trim();
        const NON_CONTACT_WORDS = /^(this|that|it|here|there|the|a|an|my|our|your)$/i;
        if (whoRaw.length >= 2 && addressRaw.length >= 5 && !NON_CONTACT_WORDS.test(whoRaw)) {
          const { capturePerson } = await import('../db/capturePerson');
          const existing = findContactByRelationship(whoRaw) ?? findContactByName(whoRaw);
          // No-junk-contact guard: if whoRaw is a bare relationship word and no
          // contact resolves to it yet, don't invent a phantom named "daughter"
          // (the directions read at ~2298 resolves by relationship — a phantom
          // would hijack it). Ask once instead. Full disambiguation + pending-
          // attach is the association layer (parked, Spine §6).
          const RELATIONSHIP_WORDS = /^(mother|mom|father|dad|daughter|son|wife|husband|sister|brother|aunt|uncle|cousin|grandma|grandpa|grandmother|grandfather|doctor|doc|dentist|neighbor|friend|boss|sister-in-law|brother-in-law|mother-in-law|father-in-law)$/i;
          if (!existing && RELATIONSHIP_WORDS.test(whoRaw)) {
            const askReply = `I want to get this right — which of your contacts is your ${whoRaw}? Tell me their name and I'll remember the address for them.`;
            addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
            addMessage({ id: generateId('msg'), role: 'assistant', content: askReply, timestamp: Date.now() });
            speak(askReply);
            sendingRef.current = false;
            setInputText('');
            return;
          }
          // Address is reachability — pass no relationship so capturePerson writes
          // contacts (the projection) without re-authoring an identity fact.
          capturePerson({
            name: existing?.name ?? whoRaw,
            address: addressRaw,
            importance: existing?.importance ?? 6,
          });
          const ackReply = `Got it — I'll remember that for next time you need directions.`;
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          addMessage({ id: generateId('msg'), role: 'assistant', content: ackReply, timestamp: Date.now() });
          speak(ackReply);
          sendingRef.current = false;
          setInputText('');
          return;
        }
      }
    }

    // ── Pending family confirm ──
    if (pendingFamilyRef.current) {
      const pending = pendingFamilyRef.current;
      if (YES.test(text.trim())) {
        pendingFamilyRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        const { capturePerson } = await import('../db/capturePerson');
        capturePerson({ name: pending.name, relationship: pending.relationship, location: pending.location });
        const reply = pending.location
          ? `Got it — I'll remember ${pending.name} is your ${pending.relationship} in ${pending.location}.`
          : `Got it — I'll remember ${pending.name} is your ${pending.relationship}.`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      if (NO.test(text.trim())) {
        pendingFamilyRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        const reply = `No problem — what's the correct name?`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      pendingFamilyRef.current = null;
    }

    // ── Pending insurance confirm ──
    if (pendingInsuranceRef.current) {
      const pending = pendingInsuranceRef.current;
      if (YES.test(text.trim())) {
        pendingInsuranceRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        const { captureHouseholdInsurance } = await import('../utils/householdCapture');
        const insId = captureHouseholdInsurance(pending.type, pending.carrier);
        const reply = insId
          ? `Got it — ${pending.carrier} for your ${pending.type} insurance.`
          : `Hmm — I couldn't hold onto that just now. Mind telling me once more?`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      if (NO.test(text.trim())) {
        pendingInsuranceRef.current = null;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        const reply = `No problem — what's the correct carrier?`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      pendingInsuranceRef.current = null;
    }

    // Household capture — runs before extractFactsLocally
    // Same order rule as phone/address/emergency capture — never move below extractFactsLocally
    const householdResult = captureHousehold(text);

    // LLM required — deterministic path can't handle this phrasing
    if (householdResult && householdResult.type === 'needs_llm') {
      if (llmStatus !== 'ready') {
        const notReadyMsg = "Give me just a moment — I'm still waking up. Say that again in a sec.";
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        addMessage({ id: generateId('msg'), role: 'assistant', content: notReadyMsg, timestamp: Date.now() });
        speak(notReadyMsg);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      // LLM is ready — fall through to LLM-first block which already ran above.
      // If it handled it, we already returned. If not, continue normal fallthrough.
    }

    // No name captured — ask for it and set up a resume to collect the name.
    if (householdResult && householdResult.type === 'needs_name') {
      const { category, phone, ack } = householdResult;
      addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
      addMessage({ id: generateId('msg'), role: 'assistant', content: ack, timestamp: Date.now() });
      speak(ack);
      pendingResumeRef.current = {
        pendingKey: `needs_name_${category}`,
        resume: async (nameText: string) => {
          const nameClean = nameText.trim();
          if (nameClean.length < 2) {
            const retry = `I didn't catch that — what's the name?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: retry, timestamp: Date.now() });
            speak(retry);
            return { status: 'noop' as const, ack: '' };
          }
          // Now we have both name and phone — write the row.
          const { writeServiceProvider } = await import('../utils/householdCapture');
          writeServiceProvider(category, nameClean, phone);
          const doneAck = `Got it — ${nameClean} is your ${category}, ${phone}.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: doneAck, timestamp: Date.now() });
          speak(doneAck);
          return { status: 'committed' as const, ack: doneAck };
        },
      };
      sendingRef.current = false;
      setInputText('');
      return;
    }

    if (householdResult && householdResult.type !== 'needs_llm' && 'captured' in householdResult) {
      if (householdResult.pendingConfirm) {
        pendingInsuranceRef.current = {
          type: householdResult.pendingConfirm.type,
          carrier: householdResult.pendingConfirm.carrier,
          ack: householdResult.ack,
        };
      }
      addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
      addMessage({ id: generateId('msg'), role: 'assistant', content: householdResult.ack, timestamp: Date.now() });
      speak(householdResult.ack);
      sendingRef.current = false;
      setInputText('');
      return;
    }

    // Emergency contact capture — runs before extractFactsLocally
    const EMERGENCY_CONTACT_PATTERNS = [
      /\bmy emergency contact is\s+([\w\s\-']+?)(?:\s+(?:and\s+)?(?:their|his|her)\s+(?:number|phone)\s+is\s+([\d\s\-\(\)\+\.]{7,}))?[.!?]?$/i,
      /\bset\s+([\w\s\-']+?)\s+as\s+(?:my\s+)?emergency contact(?:\s+(?:their|his|her)?\s*(?:number|phone)\s+is\s+([\d\s\-\(\)\+\.]{7,}))?[.!?]?$/i,
    ];
    for (const pattern of EMERGENCY_CONTACT_PATTERNS) {
      const m = text.match(pattern);
      if (m) {
        const ecName = m[1].trim();
        const ecPhone = m[2]?.replace(/\D/g, '') ?? undefined;
        let ecAckReply: string;
        try {
          setEmergencyContact(ecName, ecPhone);
          ecAckReply = ecPhone
            ? `Got it — if you ever need help, I'll reach ${ecName} at that number.`
            : `Got it — ${ecName} is your emergency contact. Tell me their number when you get a chance.`;
        } catch {
          ecAckReply = `Something went wrong holding onto that. Try again.`;
        }
        const ackReply = ecAckReply;
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        addMessage({ id: generateId('msg'), role: 'assistant', content: ackReply, timestamp: Date.now() });
        speak(ackReply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
    }

    if (!tierDecision.actionIntent && !isTier1Read) {
      // Extract facts locally — skip calendar/medical/profile reads (Bug 1)
      try {
        const beforeCount = getFactCount();
        extractFactsLocally(text);
        const afterCount = getFactCount();
        if (afterCount > beforeCount) localFactsWritten = true;
      } catch {}
      if (!localFactsWritten && isMedicalCaptureIntent(text) && userId) {
          const medCategory = medicalCategoryFromText(text);
          if (medCategory === 'medication') {
            // Always confirm before writing a medication name — corroboration
            // (a dosage, a pill word) only changes how confident the ack
            // SOUNDS, never whether we ask. Free-text name-guessing is
            // inherently low-confidence regardless of corroboration signal.
            // [Spine 4 — medical values are correction-prone, confirm always]
            const guessedName = guessMedicationName(text);
            const guessedDosage = extractDosage(text);
            if (!guessedName || guessedName.length < 2) {
              addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
              const reply = "Which medication did you want me to note?";
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
              sendingRef.current = false;
              setInputText('');
              return;
            }
            pendingMedConfirmRef.current = { category: medCategory, value: text, guessedName, guessedDosage };
            addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
            const reply = isMedicationCorroborated(text)
              ? (guessedDosage
                  ? `Got it — ${guessedName}, ${guessedDosage}. Sound right?`
                  : `Got it — ${guessedName}. Sound right?`)
              : `Want me to remember ${guessedName} as a medication?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            sendingRef.current = false;
            setInputText('');
            return;
          }
          try {
            writeMedicalFact(medCategory, text);
            localFactsWritten = true;
          } catch {}
      }
      if (!localFactsWritten) {
        const isPersonalWrite =
          /\bmy (wife|husband|spouse|partner|son|daughter|child|kids?|brother|sister|mom|dad|mother|father)('?s name)? is\b/i.test(text) ||
          /\bmy name is\b/i.test(text) ||
          /\bi('?m| am) [\d]+ years? old\b/i.test(text) ||
          /\bi live in\b/i.test(text);
        if (isPersonalWrite) localFactsWritten = true;
      }
    }
    // ── Emergency safe word — runs BEFORE offline gate (SMS/GPS work offline) ──
    // Negative lookahead prevents false-positives on "help me find/remember/set X"
    const EMERGENCY_SIGNALS = [
      /\b(i need help|call for help|i('m| am) having an emergency|this is an emergency|send help)\b/i,
      /\bhelp me\b(?!\s+(?:find|remember|with|look|check|set|add|show|get|open|play|call|text|remind|schedule|book|order|understand|explain|figure|make|write|read|tell|search|navigate|go|turn|start|stop|cancel))/i,
      /\bherald.{0,10}(help|emergency|i('m| am) scared|i('ve| have) fallen)\b/i,
    ];
    if (EMERGENCY_SIGNALS.some(p => p.test(text))) {
      addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
      const emergencyContact = getEmergencyContact();
      if (!emergencyContact?.phone) {
        const reply = `I want to help — but I don't have an emergency contact set up yet. Tell me who to reach and their number.`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      // Get current GPS location
      let locationText = '';
      try {
        const { requestForegroundPermissionsAsync, getCurrentPositionAsync, Accuracy } = await import('expo-location');
        const { status } = await requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const loc = await getCurrentPositionAsync({ accuracy: Accuracy.High, timeInterval: 3000 });
          locationText = ` My location: https://maps.google.com/?q=${loc.coords.latitude},${loc.coords.longitude}`;
        }
      } catch { /* silent — send SMS without location if GPS fails */ }
      // Open SMS to emergency contact pre-filled
      const smsBody = encodeURIComponent(`Herald alert: I may need help.${locationText}`);
      const smsUrl = `sms:${emergencyContact.phone}?body=${smsBody}`;
      await Linking.openURL(smsUrl);
      const reply = `Opening a message to ${emergencyContact.name}. Stay with me.`;
      addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
      speak(reply);
      sendingRef.current = false;
      setInputText('');
      return;
    }

    // Profile update — local SQLite, runs before offline gate
    if (tierDecision.actionIntent?.type === 'profile_update') {
      addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
      try {
        const { field, value } = tierDecision.actionIntent;
        const PROFILE_FIELD_MAP: Record<string, string> = {
          insurance: 'insurance_provider',
          doctor: 'primary_doctor',
          pharmacy: 'pharmacy',
          dentist: 'dentist',
          specialist: 'specialist',
          provider: 'insurance_provider',
        };
        const mappedKey = PROFILE_FIELD_MAP[field.toLowerCase()] ?? field.toLowerCase();
        setProfileField(mappedKey, value);
        const reply = `Got it — updated your ${field} to ${value}.`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
      } catch {
        const reply = `Something went wrong updating that. Try again.`;
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
      }
      sendingRef.current = false;
      setInputText('');
      return;
    }

    // ── Offline gate — runs AFTER emergency (emergency always fires) ─────────────────────────
    // Fix: treat null isInternetReachable as ONLINE (not offline) — null means
    // reachability check not yet complete, not that we're definitely offline.
    const isOffline = networkState.isConnected === false ||
      (networkState.isInternetReachable === false);
    if (isOffline) {
      // Tier 1 reads/actions pass through — they're device-local
      if (tierDecision.tier === 1) {
        if (tierDecision.actionIntent) {
          // Device-local action (household_read, medical_capture, alarm, etc.)
          // intentionally falls through to the Tier 1 action handler below — it
          // needs no network. Do NOT add a return here.
        } else if (tierDecision.tier1Response) {
          await dispatchRead(
            tierDecision.tier1Response,
            tierDecision.llmWrap ?? false,
            tierDecision.isMedical ?? false,
            text,
            buildDispatchDeps(),
          );
          setInputText('');
          sendingRef.current = false;
          return;
        }
      }
      if (!tierDecision.actionIntent && localFactsWritten) {
        const reply = "Got it — I'll remember that. You can ask me about it anytime.";
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
        speak(reply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      if (!tierDecision.actionIntent) {
        const localAnswer = answerFromDevice(text);
        if (localAnswer) {
          addMessage({ id: generateId('msg'), role: 'user',
            content: text, timestamp: Date.now() });
          addMessage({ id: generateId('msg'), role: 'assistant',
            content: localAnswer, timestamp: Date.now() });
          speak(localAnswer);
          sendingRef.current = false;
          setInputText('');
          return;
        }

        // Tier 1.5: on-device LLM capture — ONLY for the tier-3 gap (deterministic-first).
        // A tier-1 read/action must never be re-captured here (e.g. "who is my wife" is a
        // family READ, not a family_capture). Matches the online gate.
        if (llmStatus === 'ready' && tierDecision.tier === 3) {
          try {
            const contacts = getKnownContactNames();
            const lists = getKnownListNames();
            const results = await classifyWithLLM(text, getCtx(), {
              contacts,
              lists,
              name: undefined,
            });
            if (results.length > 0) {
              if (allConverted(results)) {
                await applyConvertedIntents(results, text, { echoUser: true });
                return;
              }
              addMessage({ id: generateId('msg'), role: 'user',
                content: text, timestamp: Date.now() });
              await dispatchLocalIntent(results[0] as Record<string, string | undefined>, text);
              return;
            }
          } catch {
            // fall through to honest fallback
          }
        }

        // Honest offline fallback
        const offlineReplies = [
          "I'm not connected right now — ask me about your calendar, medications, contacts, or lists.",
          "No connection at the moment. I can still help with anything on your phone — what do you need?",
          "I'm offline but still here. Calendar, contacts, medications, lists — what do you need?",
        ];
        const offlineReply = offlineReplies[Math.floor(Math.random() * offlineReplies.length)];
        addMessage({ id: generateId('msg'), role: 'user',
          content: text, timestamp: Date.now() });
        addMessage({ id: generateId('msg'), role: 'assistant',
          content: offlineReply, timestamp: Date.now() });
        speak(offlineReply);
        sendingRef.current = false;
        setInputText('');
        return;
      }
      // Has actionIntent — fall through to action handling below
    }

    // Tier 1: answer from device SQLite, no LLM, no network, under 200ms.
    // Tier 2: memory probe — attach structured local context to backend request.
    // Tier 3: default — existing network path unchanged.

    if (tierDecision.tier === 1) {
      // Device action intent — alarm or SMS, no network needed
      if (tierDecision.actionIntent) {
        await dispatchAction(tierDecision.actionIntent, text, buildDispatchDeps());
        // Residual scan — catch a second intent in the same utterance (compound speech)
        const residual = await scanResidualIntent(text, tierDecision.actionIntent.type);
        if (residual?.actionIntent) {
          // Layer A floor: isolate the residual commit. One clause failing must
          // never sink the other clause's ACK or the send. On failure, stay
          // honest — never silent (Spine §4: ACK must match commit state).
          try {
            await dispatchAction(residual.actionIntent, text, buildDispatchDeps());
          } catch (e) {
            console.warn('[handleSend] residual dispatch failed', e);
            const recoverReply =
              "I got the first part — say that last bit once more and I'll get it too?";
            addMessage({
              id: generateId('msg'),
              role: 'assistant',
              content: recoverReply,
              timestamp: Date.now(),
            });
            speak(recoverReply);
          }
        }
        sendingRef.current = false;
        setInputText('');
        return;
      }
      // Tier 1 read response — calendar, medical, profile
      if (tierDecision.tier1Response) {
        await dispatchRead(
          tierDecision.tier1Response,
          tierDecision.llmWrap ?? false,
          tierDecision.isMedical ?? false,
          text,
          buildDispatchDeps(),
        );
        sendingRef.current = false;
        setInputText('');
        return;
      }
    }

    // Legacy device interceptor — keep as fallback for patterns not yet
    // covered by tierRouter signal groups
    const localAnswer = answerFromDevice(text);
    if (localAnswer) {
      addMessage({
        id: generateId("msg"),
        role: "user",
        content: text,
        timestamp: now,
      });
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content: localAnswer,
        timestamp: now + 1,
      });
      speak(localAnswer);
      sendingRef.current = false;
      setInputText("");
      return;
    }
    lastInteractionRef.current = now;

    addMessage({
      id: generateId("msg"),
      role: "user",
      content: text,
      timestamp: now,
    });

    setError(null);
    setPendingAction(null);
    resetSpeech();
    const isMedicalPast =
      /went to|had (a|my|the)|saw (the|my)|doctor said|diagnosed|got my|results came/i.test(text) &&
      /doctor|visit|appointment|hospital|clinic|specialist|surgery|procedure|test|lab/i.test(text);
    const isMedical =
      /doctor|medication|prescription|symptom|hospital|pharmacy|appointment|diagnosis|surgery|therapy|feel (bad|sick|awful)/i.test(text);
    const isLookup =
      /what (is|are|was|were)|how (much|many|far|long|old)|when (is|was|does)|where (is|was)|who (is|was)|square root|calculate|convert|\d+\s*[\+\-\*\/]/i.test(text);

    let _bridgePhrase: string;
    if (isMedicalPast) {
      const _medPast = ["How did that go?", "Everything alright?", "Let me pull that up..."];
      _bridgePhrase = _medPast[Math.floor(Math.random() * _medPast.length)];
    } else if (isMedical) {
      _bridgePhrase = "Let me check on that...";
    } else if (isLookup) {
      _bridgePhrase = Math.random() < 0.5 ? "Let me get that..." : "Let me check on that...";
    } else {
      const _default = [
        "Let me check on that...",
        "Let me grab that...",
        "Let me find that...",
        "Give me just a moment...",
        "Let me look that up...",
        "Let me think on that...",
      ];
      _bridgePhrase = _default[Math.floor(Math.random() * _default.length)];
    }
    speak(_bridgePhrase);

    setShowProactive(false);
    setIsWaiting(true);
    setIsStreaming(true);
    setStreamingContent("");
    isAtBottomRef.current = true;

    let firstToken = true;

    // Fresh device clock on every send — backend resolve_relative_dates depends on this
    const _now = new Date();
    const local_date = _now.toLocaleDateString('en-CA'); // YYYY-MM-DD always
    const local_time = _now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const activeTopicsList = getActiveTopics();
    const activeTopicsParam =
      activeTopicsList.length > 0 ? activeTopicsList.join(",") : undefined;

    const abortController = askHeraldStream(
      {
        user_id: userId,
        message: text,
        history: historySnapshot,
        local_time,
        local_date,
        device_context: tierDecision.tier === 2 && tierDecision.localContext
          ? buildTier2DeviceContext(tierDecision.localContext)
          : buildAmbientDeviceContext(getContextBlock() || undefined),
        persona: personaKey,
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        location_label: locationLabel ?? undefined,
        active_topics: activeTopicsParam,
      },
      {
        onToken: (token) => {
          if (firstToken) {
            firstToken = false;
            stop();
            setIsWaiting(false);
            flatListRef.current?.scrollToEnd({ animated: true });
            const maxStreamTimer = setTimeout(() => {
              if (streamAbortRef.current) {
                streamAbortRef.current.abort();
                addMessage({
                  id: generateId("msg"),
                  role: "assistant",
                  content: "That took longer than expected — try asking again.",
                  timestamp: Date.now(),
                });
                resetStreamState();
                setError('Response timed out. Try again.');
              }
            }, 60_000);
            if (streamAbortRef.current) {
              (streamAbortRef.current as any)._maxTimer = maxStreamTimer;
            }
          }
          tokenBatchRef.current += token;
          if (!batchTimerRef.current) {
            batchTimerRef.current = setTimeout(() => {
              const batch = tokenBatchRef.current;
              tokenBatchRef.current = '';
              batchTimerRef.current = null;
              if (batch) setStreamingContent((prev) => prev + batch);
            }, 80);
          }
        },
        onSentence: (sentence) => { enqueueSentence(sentence); },
        onAction: (action) => {
          if (!action) return;
          if (action.type === "launch") {
            const appKey = canonicalKey(action.value as string ?? "");
            if (autoOpenAppsRef.current.has(appKey)) {
              executeIntent(action as IntentAction);
              return;
            }
          }
          setPendingAction(action as IntentAction);
          setActionStatus("confirming");
        },
        onFacts: (facts) => {
          // Write to structured factDB — temporal detection, dedup, importance scoring
          writeFacts(facts);

          // Route to typed device tables (medicalDB, contactsDB)
          for (const fact of facts) {
            if (!fact.value?.trim()) continue;

            const MEDICAL_CATEGORIES = new Set([
              'medication', 'medications', 'medical', 'visit',
              'doctor', 'diagnosis', 'symptom', 'procedure',
              'allergy', 'condition', 'lab', 'test', 'health'
            ]);

            if (MEDICAL_CATEGORIES.has(fact.category)) {
              // Never auto-write a medication from backend fact-extraction — meds
              // are correction-prone and must be confirmed (Spine §4, Jun-20).
              // Mirror only non-medication medical notes here; medications flow
              // through the confirm-gated capture paths.
              if (fact.category !== 'medication' && fact.category !== 'medications') {
                writeMedicalFact('medical', fact.value);
              }
            }
          }
        },
        onDone: (fullText) => {
          if (batchTimerRef.current) {
            clearTimeout(batchTimerRef.current);
            batchTimerRef.current = null;
          }
          if (tokenBatchRef.current) {
            setStreamingContent((prev) => prev + tokenBatchRef.current);
            tokenBatchRef.current = '';
          }
          if (fullText.trim()) {
            addMessage({ id: generateId("msg"), role: "assistant", content: fullText, timestamp: Date.now() });
            void Promise.resolve().then(() => {
              try {
                for (const topic of extractTopicsFromMessage(text)) {
                  recordTopicMention(topic);
                }
              } catch {}
            });
          }
          resetStreamState();
        },
        onError: (err) => {
          if (batchTimerRef.current) {
            clearTimeout(batchTimerRef.current);
            batchTimerRef.current = null;
          }
          tokenBatchRef.current = '';
          setError(err.message);
          resetStreamState();
        },
      }
    );

    streamAbortRef.current = abortController;
    setInputText("");
    } catch (e) {
      console.error('[Herald] sendMessage error:', e);
      const isAbort =
        (e instanceof Error && e.name === 'AbortError') ||
        (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError');
      if (!isAbort) {
        addMessage({
          id: generateId('msg'),
          role: 'assistant',
          content: 'Sorry — something went wrong on my end. Try that again?',
          timestamp: Date.now(),
        });
      }
      resetStreamState();
    } finally {
      // Passive personality observation — fires after every turn, success or failure
      try {
        const lastAssistant = messages[messages.length - 1];
        writeTurnObservation({
          userText: text,
          assistantText: lastAssistant?.role === 'assistant' ? lastAssistant.content : '',
          intentReason: undefined,
          timestampMs: Date.now(),
          wasCorrection: /\b(no|wrong|not what i meant|that's not right)\b/i.test(text),
        });
      } catch { /* never block the UI */ }
    }
  }, [userId, messages, personaKey, lat, lng, locationLabel, getContextBlock, addMessage, setError, resetSpeech, enqueueSentence, resetStreamState, stop, llmStatus, getCtx, dispatchLocalIntent]);

  const handleSend = useCallback(() => {
    sendMessage(inputText.trim());
  }, [inputText, sendMessage]);

  const handleTranscript = useCallback((transcript: string) => {
    if (!transcript.trim()) return;
    const trimmed = transcript.trim().slice(0, 2000);
    // Brief display in input bar so user sees what was heard, then send
    setInputText(trimmed);
    setTimeout(() => {
      setInputText('');
      sendMessage(trimmed);
    }, 600);
  }, [sendMessage]);
  const { isRecording, startRecording, stopRecording } = useMic(handleTranscript);

  useRaiseToWake({
    aiName: aiName || 'Herald',
    onWake: () => {
      // Phone moved + name heard → activate mic as if user pressed button
      if (!sendingRef.current && !isStreaming) {
        startRecording();
      }
    },
    enabled: false,
  });

  useEffect(() => {
    handsFreeRef.current = handsFreeMode;
  }, [handsFreeMode]);

  useEffect(() => {
    if (!isSpeaking && handsFreeRef.current && !isStreaming) {
      const timer = setTimeout(() => startRecording(), 300);
      return () => clearTimeout(timer);
    }
  }, [isSpeaking, isStreaming, startRecording]);

  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording]);

  // ── Intent execution ──────────────────────────────────────────────────────

  const executeIntent = async (action: IntentAction) => {
    setActionStatus("executing");
    try {
      switch (action.type) {
        case "calendar":
          await handleCalendarAction(action.value);
          break;
        case "maps":
          await handleMapsAction(action.value);
          break;
        case "sms":
          await handleSMSAction(action.value);
          break;
        case "phone": {
          // If value looks like a raw number, dial directly.
          // If it looks like a name/relationship, resolve first.
          const rawVal = action.value.trim();
          const looksLikeNumber = /^[\d\s\-\+\(\)]+$/.test(rawVal) && rawVal.replace(/\D/g, '').length >= 7;
          if (looksLikeNumber) {
            await Linking.openURL(`tel:${rawVal.replace(/\D/g, '')}`);
          } else {
            // Resolve name/relationship to phone number
            const resolved = await resolveContactPhone(rawVal);
            if (resolved?.phone) {
              updateLastContact(resolved.contactId ?? '');
              await Linking.openURL(`tel:${resolved.phone}`);
              addMessage({
                id: generateId("msg"),
                role: "assistant",
                content: `Calling ${resolved.name} now.`,
                timestamp: Date.now(),
              });
            } else {
              // Can't resolve — open dialer so user can dial manually
              await Linking.openURL(`tel:`);
              addMessage({
                id: generateId("msg"),
                role: "assistant",
                content: `I couldn't find a number for ${rawVal}. The dialer is open — or tell me their number and I'll remember it.`,
                timestamp: Date.now(),
              });
            }
          }
          break;
        }
        case "flights":
          await Linking.openURL(
            `https://www.google.com/flights?q=${encodeURIComponent(action.value)}`
          );
          break;
        case "search": {
          const q = action.value ?? "";
          // If the query is YouTube-related, open YouTube app or site directly
          if (/youtube/i.test(q)) {
            const searchTerm = q.replace(/youtube/gi, "").trim();
            const ytApp = `vnd.youtube://results?search_query=${encodeURIComponent(searchTerm || "trending")}`;
            const ytWeb = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchTerm || "trending")}`;
            try {
              await Linking.openURL(ytApp);
            } catch {
              await Linking.openURL(ytWeb);
            }
          } else {
            await Linking.openURL(
              `https://www.google.com/search?q=${encodeURIComponent(q)}`
            );
          }
          break;
        }
        case "launch":
          await handleLaunchAction(action.value);
          break;
        case "music":
          await Linking.openURL(
            `https://open.spotify.com/search/${encodeURIComponent(action.value)}`
          );
          break;
        case "radio":
          await Linking.openURL(
            `https://www.google.com/search?q=${encodeURIComponent(action.value + " radio stream")}`
          );
          break;
        case "alarm": {
          const alarmParts = action.value.split("|");
          const alarmTime  = alarmParts[0]?.trim() || "";
          const alarmLabel = alarmParts[1]?.trim() || "Herald Alarm";
          const alarmHour  = alarmTime.split(":")[0] || "0";
          const alarmMins  = alarmTime.split(":")[1] || "0";

          // Generic clock app last resort
          const clockUrl = `intent:#Intent;action=android.intent.action.SHOW_ALARMS;end`;

          let opened = false;
          if (Platform.OS === 'android') {
            try {
              await IntentLauncher.startActivityAsync('android.intent.action.SET_ALARM', {
                extra: {
                  'android.intent.extra.alarm.HOUR': parseInt(alarmHour, 10),
                  'android.intent.extra.alarm.MINUTES': parseInt(alarmMins, 10),
                  'android.intent.extra.alarm.MESSAGE': alarmLabel,
                  'android.intent.extra.alarm.SKIP_UI': true,
                },
              });
              opened = true;
            } catch {
              try {
                await Linking.openURL(clockUrl);
                opened = true;
              } catch (e) {
                console.error("[Herald] All alarm intents failed:", e);
              }
            }
          }

          addMessage({
            id: generateId("msg"),
            role: "assistant",
            content: opened
              ? `Alarm set for ${alarmTime} — ${alarmLabel}.`
              : `I couldn't open the clock app directly. Open your clock app and set it for ${alarmTime}.`,
            timestamp: Date.now(),
          });
          break;
        }
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }
      setActionStatus("done");
      setTimeout(() => {
        setPendingAction(null);
        setActionStatus("confirming");
      }, 2000);
    } catch (err) {
      console.error("[Herald] executeIntent failed:", err);
      setActionStatus("error");
      setTimeout(() => {
        setPendingAction(null);
        setActionStatus("confirming");
      }, 3000);
    }
  };

  // ── Calendar action ───────────────────────────────────────────────────────

  const handleCalendarAction = async (value: string) => {
    const parts = value.split("|");
    const title = parts[0]?.trim() || "Appointment";
    const dateStr = parts[1]?.trim() || "";
    const timeStr = parts[2]?.trim() || "";

    if (!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr)) {
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content: `What time should I put "${title}" on your calendar?`,
        timestamp: Date.now(),
      });
      setPendingAction(null);
      setActionStatus("confirming");
      return;
    }

    // Calendar writes use device CalendarProvider — no network required (Bug 3)
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== "granted") {
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content:
          "I need calendar access to do that. Open your phone Settings, find Herald, and turn on Calendar. Then ask me again.",
        timestamp: Date.now(),
      });
      throw new Error("calendar permission denied");
    }

    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const writable = calendars.filter((c) => c.allowsModifications);
    if (!writable.length) {
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content:
          "I couldn't find a calendar I can write to. Make sure Google Calendar or Samsung Calendar is set up, then try again.",
        timestamp: Date.now(),
      });
      throw new Error("no writable calendar");
    }

    const targetCal =
      writable.find((c) => c.isPrimary) ||
      writable.find((c) => c.source?.type === "com.google") ||
      writable[0];

    let startDate: Date;
    try {
      const [h, m] = timeStr.split(":").map(Number);
      if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [year, month, day] = dateStr.split("-").map(Number);
        startDate = new Date();
        startDate.setFullYear(year, month - 1, day);
        startDate.setHours(h, m, 0, 0);
      } else {
        startDate = new Date();
        startDate.setDate(startDate.getDate() + 1);
        startDate.setHours(h || 9, m || 0, 0, 0);
      }
      if (isNaN(startDate.getTime())) throw new Error("invalid date");
    } catch {
      startDate = new Date();
      startDate.setDate(startDate.getDate() + 1);
      startDate.setHours(9, 0, 0, 0);
    }

    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    await Calendar.createEventAsync(targetCal.id, {
      title,
      startDate,
      endDate,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      notes: "Added by Herald",
    });

    const timeDisplay = startDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const dateDisplay = startDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    addMessage({
      id: generateId("msg"),
      role: "assistant",
      content: `Done — "${title}" is on your calendar for ${dateDisplay} at ${timeDisplay}.`,
      timestamp: Date.now(),
    });
    markCalendarWrite();
    await refreshCalendarCache().catch(() => {}); // await so post-write queries hit fresh cache
  };

  const handleMapsAction = async (query: string) => {
    // Sanitize: strip natural language preamble from LLM output
    // e.g. "the address I'm looking for is 6646 Mims Street" → "6646 Mims Street"
    let destination = query
      .replace(/^(the address (i('m| am) looking for( is)?|is)|directions? to( the)?|navigate to( the)?|take me to( the)?)\s*/i, '')
      .trim();

    // Bug 7 fix: "nearest X" queries use live GPS, not stored home location.
    // Proximity intent — call GPS at query time, not onboarding time.
    const isProximityQuery = /\b(nearest|near me|near here|closest|close to me|from here|directions from here|from my location|from where i am)\b/i.test(query);
    let liveOrigin: string | null = null;
    if (isProximityQuery) {
      try {
        const { requestForegroundPermissionsAsync, getCurrentPositionAsync, Accuracy } = await import('expo-location');
        const { status } = await requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const loc = await getCurrentPositionAsync({
            accuracy: Accuracy.Balanced,
            timeInterval: 3000,
          });
          liveOrigin = `${loc.coords.latitude},${loc.coords.longitude}`;
        }
      } catch {
        // Silent — fall through to stored location or no origin
      }
    }

    // Check if destination is a person/relationship rather than an address
    const looksLikePlace = /\d|street|st\b|ave\b|avenue|drive|dr\b|road|rd\b|blvd|lane|ln\b|way\b|court|ct\b|highway|hwy|mall|airport|hospital|park\b/i.test(destination);

    if (!looksLikePlace) {
      try {
        const { findContactByRelationship, findContactByName } = await import("../db/contactsDB");
        const contact = await findContactByRelationship(destination)
                     ?? await findContactByName(destination);
        if (contact?.address) {
          destination = contact.address;
        }
        // If no address found, fall through with original destination string
      } catch {
        // Silent — fall through with original destination
      }
    }

    // Append confirmed city if destination looks like a street address without a city
    // e.g. "6646 Mims Street" → "6646 Mims Street, Plano TX"
    const hasCity = /,\s*[A-Za-z]|\b(tx|ca|fl|ny|wa|il|pa|oh|ga|nc|mi|nj|va|az|co|tn|in|mo|md|wi|mn|sc|al|la|ky|or|ok|ct|ut|ia|nv|ar|ms|ks|ne|nm|id|wv|hi|nh|me|ri|mt|de|sd|nd|ak|vt|wy|dc)\b/i.test(destination);
    if (!hasCity && /\d/.test(destination)) {
      const { getProfileField } = await import("../db/profileDB");
      const city = getProfileField("city");
      if (city) destination = `${destination}, ${city}`;
    }

    const encoded = encodeURIComponent(destination);
    const googleApp = liveOrigin
      ? `comgooglemaps://?q=${encoded}&saddr=${liveOrigin}`
      : `comgooglemaps://?q=${encoded}`;
    const googleWeb = liveOrigin
      ? `https://maps.google.com/maps?saddr=${liveOrigin}&daddr=${encoded}`
      : `https://maps.google.com/maps?q=${encoded}`;
    try {
      const canGoogle = await Linking.canOpenURL(googleApp);
      await Linking.openURL(canGoogle ? googleApp : googleWeb);
    } catch {
      await Linking.openURL(googleWeb);
    }
  };

  // ── resolveContactPhone ──────────────────────────────────────────────────────
  // Resolves a name or relationship to a phone number.
  // Pass 1: Herald contacts table (contactsDB) — fastest, device SQLite
  // Pass 2: OS device contacts via expo-contacts — broader coverage
  // Returns null if not found — caller handles graceful fallback.

  const resolveContactPhone = async (nameOrRelation: string): Promise<{ phone: string; name: string; contactId?: string } | null> => {
    const clean = nameOrRelation.trim().toLowerCase();

    // Pass 1: Herald contacts table
    const byRelation = findContactByRelationship(clean);
    if (byRelation?.phone) {
      return { phone: byRelation.phone, name: byRelation.name, contactId: byRelation.id };
    }
    const byName = findContactByName(clean);
    if (byName?.phone) {
      return { phone: byName.phone, name: byName.name, contactId: byName.id };
    }

    // Pass 2: OS device contacts
    try {
      const Contacts = await import('expo-contacts');
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') return null;

      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Name],
      });

      if (!data?.length) return null;

      // Find best match — prioritize exact name match, then partial
      const exactMatch = data.find(c =>
        c.name?.toLowerCase() === clean ||
        c.firstName?.toLowerCase() === clean ||
        c.lastName?.toLowerCase() === clean
      );
      const partialMatch = data.find(c =>
        c.name?.toLowerCase().includes(clean) ||
        c.firstName?.toLowerCase().includes(clean)
      );

      const match = exactMatch ?? partialMatch;
      if (match?.phoneNumbers?.[0]?.number) {
        const phone = match.phoneNumbers[0].number.replace(/\D/g, '');
        const name = match.name ?? nameOrRelation;
        // Write to Herald contacts for next time
        writeContact({ name, phone, importance: 5 });
        return { phone, name };
      }
    } catch (e) {
      console.warn('[resolveContactPhone] expo-contacts failed:', e);
    }

    return null;
  };
  resolveContactPhoneRef.current = resolveContactPhone;

  const handleSMSAction = async (value: string) => {
    const pipeIdx = value.indexOf("|");
    const contactRaw  = pipeIdx >= 0 ? value.substring(0, pipeIdx).trim() : value.trim();
    const messageText = pipeIdx >= 0 ? value.substring(pipeIdx + 1).trim() : "";
    const body = encodeURIComponent(messageText);

    // Offline: queue the write instead of failing
    const networkState = await Network.getNetworkStateAsync();
    const offline = !networkState.isConnected || !networkState.isInternetReachable;

    // Try to resolve contact to phone number
    const resolved = contactRaw ? await resolveContactPhone(contactRaw) : null;

    if (offline) {
      if (resolved?.phone) {
        const smsUrl = `sms:${resolved.phone}?body=${body}`;
        await Linking.openURL(smsUrl);
        if (resolved.contactId) updateLastContact(resolved.contactId);
        addMessage({
          id: generateId("msg"),
          role: "assistant",
          content: `You're offline, but Messages is open to ${resolved.name} with your message ready — just hit send.`,
          timestamp: Date.now(),
        });
      } else {
        const smsUrl = Platform.OS === "ios" ? `sms:&body=${body}` : `sms:?body=${body}`;
        await Linking.openURL(smsUrl);
        addMessage({
          id: generateId("msg"),
          role: "assistant",
          content: `You're offline, but Messages is open with your note ready — just pick ${resolved?.name ?? contactRaw} and hit send.`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (resolved?.phone) {
      // Full pre-fill — phone number AND body. One tap to send.
      const smsUrl = `sms:${resolved.phone}?body=${body}`;
      await Linking.openURL(smsUrl);
      if (resolved.contactId) updateLastContact(resolved.contactId);
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content: `Messages is open to ${resolved.name} with your message ready. Just hit send.`,
        timestamp: Date.now(),
      });
    } else {
      // No number found — open Messages with body pre-filled, user picks contact
      const smsUrl = Platform.OS === "ios" ? `sms:&body=${body}` : `sms:?body=${body}`;
      await Linking.openURL(smsUrl);
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content: contactRaw
          ? `Messages is open with your note ready — just pick ${contactRaw} and hit send. If you tell me ${contactRaw}'s number I'll remember it for next time.`
          : `Messages is open with your note ready. Just pick your contact and hit send.`,
        timestamp: Date.now(),
      });
    }
  };

  // Canonical key map — aliases that should share the same permission
  const CANONICAL_KEYS: Record<string, string> = {
    aa: 'americanairlines',
    bofa: 'bankofamerica',
    amex: 'americanexpress',
    max: 'hbomax',
    marriott: 'marriottbonvoy',
    shealth: 'health',
    samsunghealth: 'health',
    samsungwallet: 'samsungpay',
    ubereats: 'uber',
    x: 'twitter',
    express_scripts: 'expressscripts',
    expressscripts_app: 'expressscripts',
  };

  const canonicalKey = (k: string): string => {
    const base = k.toLowerCase().trim()
      .replace(/\s+/g, '')
      .replace(/[_+]/g, '');
    return CANONICAL_KEYS[base] ?? base;
  };

  const handleLaunchAction = async (appName: string) => {
    const key = canonicalKey(appName);
    const launchApps: Record<string, { deep: string | string[]; fallback?: string }> = {
      // ── Social ────────────────────────────────────────────────────────────
      youtube:          { deep: "youtube://",        fallback: "https://youtube.com" },
      tiktok:           { deep: "tiktok://",         fallback: "https://tiktok.com" },
      twitter:          { deep: "twitter://",        fallback: "https://twitter.com" },
      x:                { deep: "twitter://",        fallback: "https://twitter.com" },
      instagram:        { deep: "instagram://",      fallback: "https://instagram.com" },
      facebook:         { deep: "intent:#Intent;action=android.intent.action.VIEW;package=com.facebook.katana;end", fallback: "https://facebook.com" },
      linkedin:         { deep: "linkedin://",       fallback: "https://linkedin.com" },
      pinterest:        { deep: "pinterest://",      fallback: "https://pinterest.com" },
      truthsocial:      { deep: "truthsocial://",    fallback: "https://truthsocial.com" },
      // ── Ride share ────────────────────────────────────────────────────────
      uber:             { deep: "intent:#Intent;package=com.ubercab;end",              fallback: "https://uber.com" },
      lyft:             { deep: "intent:#Intent;package=me.lyft.android;end",          fallback: "https://lyft.com" },
      // ── Food delivery ─────────────────────────────────────────────────────
      doordash:         { deep: "intent:#Intent;package=com.doordash.consumer;end",    fallback: "https://doordash.com" },
      ubereats:         { deep: "intent:#Intent;package=com.ubercab.eats;end",         fallback: "https://ubereats.com" },
      grubhub:          { deep: "intent:#Intent;package=com.grubhub.android;end",      fallback: "https://grubhub.com" },
      instacart:        { deep: "intent:#Intent;package=com.instacart.client;end",     fallback: "https://instacart.com" },
      // ── Dining ───────────────────────────────────────────────────────────
      chilis:           { deep: "intent:#Intent;package=com.chilifresh.chilis;end", fallback: "https://chilis.com" },
      starbucks:        { deep: "intent:#Intent;package=com.starbucks.mobilecard;end", fallback: "https://starbucks.com" },
      chipotle:         { deep: "intent:#Intent;package=com.chipotle.ordering;end",    fallback: "https://chipotle.com" },
      // ── Shopping ─────────────────────────────────────────────────────────
      amazon:           { deep: "amazon://",         fallback: "https://amazon.com" },
      walmart:          { deep: "intent:#Intent;package=com.walmart.android;end",      fallback: "https://walmart.com" },
      target:           { deep: "intent:#Intent;package=com.target.ui;end",            fallback: "https://target.com" },
      bestbuy:          { deep: "bestbuy://",        fallback: "https://bestbuy.com" },
      costco:           { deep: "intent:#Intent;package=com.costco.costcomobile;end",  fallback: "https://costco.com" },
      samsclub:         { deep: "samsclub://",       fallback: "https://samsclub.com" },
      yelp:             { deep: "yelp://",           fallback: "https://yelp.com" },
      // ── Music ────────────────────────────────────────────────────────────
      spotify:          { deep: "spotify://",        fallback: "https://open.spotify.com" },
      // ── Maps / navigation ─────────────────────────────────────────────────
      googlemaps:       { deep: "comgooglemaps://",  fallback: "https://maps.google.com" },
      maps:             { deep: "comgooglemaps://",  fallback: "https://maps.google.com" },
      // ── Email / productivity ──────────────────────────────────────────────
      gmail:            { deep: "googlegmail://",    fallback: "https://mail.google.com" },
      googledocs:       { deep: "googledocs://",     fallback: "https://docs.google.com" },
      googledrive:      { deep: "googledrive://",    fallback: "https://drive.google.com" },
      zoom:             { deep: "zoomus://",         fallback: "https://zoom.us" },
      teams:            { deep: "msteams://",        fallback: "https://teams.microsoft.com" },
      // ── Airlines ─────────────────────────────────────────────────────────
      americanairlines: { deep: "intent:#Intent;package=com.aa.android;end",           fallback: "https://aa.com" },
      aa:               { deep: "intent:#Intent;package=com.aa.android;end",           fallback: "https://aa.com" },
      delta:            { deep: "fly-delta://",                                         fallback: "https://delta.com" },
      southwest:        { deep: "intent:#Intent;package=com.southwest.airlines;end",   fallback: "https://southwest.com" },
      united:           { deep: "intent:#Intent;package=com.united.mobile.android;end", fallback: "https://united.com" },
      // ── Hotels ───────────────────────────────────────────────────────────
      airbnb:           { deep: "airbnb://",         fallback: "https://airbnb.com" },
      hotels:           { deep: "hotels://",         fallback: "https://hotels.com" },
      hilton:           { deep: "intent:#Intent;package=com.hilton.android.hhonors;end", fallback: "https://hilton.com" },
      marriott:         { deep: "marriottbonvoy://", fallback: "https://marriott.com" },
      marriottbonvoy:   { deep: "marriottbonvoy://", fallback: "https://marriott.com" },
      hyatt:            { deep: "intent:#Intent;package=com.hyatt.android;end",     fallback: "https://hyatt.com" },
      ihg:              { deep: "intent:#Intent;package=com.ihg.apps.android;end",     fallback: "https://ihg.com" },
      // ── Car rental ───────────────────────────────────────────────────────
      hertz:            { deep: "intent:#Intent;package=com.hertz.mobile.android;end", fallback: "https://hertz.com" },
      enterprise:       { deep: "intent:#Intent;package=com.ehi.enterprise;end",       fallback: "https://enterprise.com" },
      avis:             { deep: "intent:#Intent;package=com.avis.androidapp;end",      fallback: "https://avis.com" },
      nationalcar:      { deep: "intent:#Intent;package=com.nationalcar;end",       fallback: "https://nationalcar.com" },
      budget:           { deep: "intent:#Intent;package=com.budget.android;end",    fallback: "https://budget.com" },
      // ── Travel ───────────────────────────────────────────────────────────
      tripadvisor:      { deep: "tripadvisor://",    fallback: "https://tripadvisor.com" },
      // ── Streaming ────────────────────────────────────────────────────────
      netflix:          { deep: "netflix://",        fallback: "https://netflix.com" },
      hulu:             { deep: "intent:#Intent;package=com.hulu.plus;end",            fallback: "https://hulu.com" },
      disneyplus:       { deep: "intent:#Intent;package=com.disney.disneyplus;end",    fallback: "https://disneyplus.com" },
      hbomax:           { deep: "intent:#Intent;package=com.hbo.hbonow;end",           fallback: "https://max.com" },
      max:              { deep: "intent:#Intent;package=com.hbo.hbonow;end",           fallback: "https://max.com" },
      peacock:          { deep: "intent:#Intent;package=com.peacocktv.peacockandroid;end", fallback: "https://peacocktv.com" },
      paramountplus:    { deep: "intent:#Intent;package=com.cbs.ott;end",             fallback: "https://paramountplus.com" },
      appletv:          { deep: "videos://",         fallback: "https://tv.apple.com" },
      'disney+':        { deep: "intent:#Intent;package=com.disney.disneyplus;end",    fallback: "https://disneyplus.com" },
      'paramount+':     { deep: "intent:#Intent;package=com.cbs.ott;end",              fallback: "https://paramountplus.com" },
      'appletv+':       { deep: "videos://",                                            fallback: "https://tv.apple.com" },
      'apple tv+':      { deep: "videos://",                                            fallback: "https://tv.apple.com" },
      espn:             { deep: "intent:#Intent;package=com.espn.score_center;end",   fallback: "https://espn.com" },
      // ── Cinema ───────────────────────────────────────────────────────────
      amc:              { deep: "amc://",            fallback: "https://amctheatres.com" },
      fandango:         { deep: "fandango://",       fallback: "https://fandango.com" },
      // ── Pharmacy / health ─────────────────────────────────────────────────
      cvs:              { deep: "intent:#Intent;package=com.cvs.launchers.cvs;end",   fallback: "https://cvs.com" },
      walgreens:        { deep: "intent:#Intent;package=com.walgreens.riteaid.mobile;end", fallback: "https://walgreens.com" },
      mychart:          { deep: "epicmychart://",    fallback: "https://mychart.com" },
      goodrx:           { deep: "intent:#Intent;package=com.goodrx;end",              fallback: "https://goodrx.com" },
      expressscripts:   { deep: "expressscripts://", fallback: "https://express-scripts.com" },
      // ── Banking / finance ─────────────────────────────────────────────────
      chase:            { deep: "intent:#Intent;package=com.chase.sig.android;end",   fallback: "https://chase.com" },
      bankofamerica:    { deep: "intent:#Intent;package=com.infonow.bofa;end",        fallback: "https://bankofamerica.com" },
      bofa:             { deep: "intent:#Intent;package=com.infonow.bofa;end",        fallback: "https://bankofamerica.com" },
      wellsfargo:       { deep: "intent:#Intent;package=com.wf.wellsfargomobile;end", fallback: "https://wellsfargo.com" },
      amex:             { deep: "intent:#Intent;package=com.americanexpress.android.acctsvcs.us;end", fallback: "https://americanexpress.com" },
      americanexpress:  { deep: "intent:#Intent;package=com.americanexpress.android.acctsvcs.us;end", fallback: "https://americanexpress.com" },
      robinhood:        { deep: "intent:#Intent;package=com.robinhood.android;end",   fallback: "https://robinhood.com" },
      fidelity:         { deep: "intent:#Intent;package=com.fidelity.android;end",    fallback: "https://fidelity.com" },
      schwab:           { deep: "intent:#Intent;package=com.schwab.mobile;end",       fallback: "https://schwab.com" },
      venmo:            { deep: "intent:#Intent;package=com.venmo;end",               fallback: "https://venmo.com" },
      paypal:           { deep: "intent:#Intent;package=com.paypal.android.p2pmobile;end", fallback: "https://paypal.com" },
      zelle:            { deep: "intent:#Intent;package=com.zellepay.zelle;end",      fallback: "https://zellepay.com" },
      // ── Books / audio ─────────────────────────────────────────────────────
      audible:          { deep: "intent:#Intent;package=com.audible.application;end", fallback: "https://audible.com" },
      kindle:           { deep: "intent:#Intent;package=com.amazon.kindle;end",       fallback: "https://read.amazon.com" },
      // ── News ─────────────────────────────────────────────────────────────
      cnn:              { deep: "cnn://",            fallback: "https://cnn.com" },
      foxnews:          { deep: "foxnews://",        fallback: "https://foxnews.com" },
      // ── Senior / lifestyle ────────────────────────────────────────────────
      aarp:             { deep: "intent:#Intent;package=org.aarp.aarpnow;end",        fallback: "https://aarp.org" },
      // ── Photos / gallery (all Android) ────────────────────────────────────
      googlephotos:     { deep: "googlephotos://",   fallback: "https://photos.google.com" },
      photos:           { deep: "googlephotos://",   fallback: "https://photos.google.com" },
      photoalbum:       { deep: "googlephotos://",   fallback: "https://photos.google.com" },
      myphotoalbum:     { deep: "googlephotos://",   fallback: "https://photos.google.com" },
      myphotos:         { deep: "googlephotos://",   fallback: "https://photos.google.com" },
      gallery:          { deep: [
                            "intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.sec.android.gallery3d;end",
                            "intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.google.android.apps.photos;end",
                            "googlephotos://"
                          ], fallback: "https://photos.google.com" },
      // ── Samsung Health (Samsung only — correct) ────────────────────────────
      health:           { deep: "com.sec.android.app.shealth://", fallback: "https://www.samsung.com/us/samsunghealthapp/" },
      shealth:          { deep: "com.sec.android.app.shealth://", fallback: "https://www.samsung.com/us/samsunghealthapp/" },
      samsunghealth:    { deep: "com.sec.android.app.shealth://", fallback: "https://www.samsung.com/us/samsunghealthapp/" },
      walking:          { deep: "com.sec.android.app.shealth://", fallback: "https://www.samsung.com/us/samsunghealthapp/" },
      workout:          { deep: "com.sec.android.app.shealth://", fallback: "https://www.samsung.com/us/samsunghealthapp/" },
      steps:            { deep: "com.sec.android.app.shealth://", fallback: "https://www.samsung.com/us/samsunghealthapp/" },
      healthconnect:    { deep: "com.google.android.apps.healthdata://", fallback: "https://health.google/health-connect-android/" },
      // ── Samsung specific (Samsung only — correct) ──────────────────────────
      samsungpay:       { deep: "samsungpay://",     fallback: "https://www.samsung.com/us/samsung-pay/" },
      samsungwallet:    { deep: "samsungpay://",     fallback: "https://www.samsung.com/us/samsung-pay/" },
      bixby:            { deep: "bixby://",          fallback: "https://www.samsung.com/us/apps/bixby/" },
      // ── Device / system (all Android) ─────────────────────────────────────
      settings:         { deep: "intent:#Intent;action=android.settings.SETTINGS;end" },
      dialer:           { deep: "intent:#Intent;action=android.intent.action.DIAL;end" },
      phone:            { deep: "intent:#Intent;action=android.intent.action.DIAL;end" },
      calculator:       { deep: "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.APP_CALCULATOR;end" },
      files:            { deep: "intent:#Intent;action=android.intent.action.VIEW;type=resource/folder;end" },
    };

    const app = launchApps[key];
    if (app) {
      const links = Array.isArray(app.deep) ? app.deep : [app.deep];
      for (const link of links) {
        try {
          await Linking.openURL(link);
          return;
        } catch {
          // try next deep link or web fallback
        }
      }
      if (app.fallback) {
        await Linking.openURL(app.fallback);
        return;
      }
    }

    await Linking.openURL(
      `https://www.google.com/search?q=${encodeURIComponent(appName)}`
    );
  };
  handleLaunchActionRef.current = handleLaunchAction;

  const handleConfirmIntent = useCallback(async () => {
    if (!pendingAction || actionStatus === "executing") return;
    // Store per-app permission on confirm — next time opens directly
    if (pendingAction.type === "launch") {
      const appKey = canonicalKey(pendingAction.value as string ?? "");
      if (appKey) {
        autoOpenAppsRef.current.add(appKey);
        AsyncStorage.setItem(
          'herald_auto_open_apps',
          JSON.stringify([...autoOpenAppsRef.current])
        );
      }
    }
    await executeIntent(pendingAction);
  }, [pendingAction, actionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDismissIntent = useCallback(() => {
    setPendingAction(null);
    setActionStatus("confirming");
  }, []);

  const handleDismissProactive = useCallback(
    (id: string) => {
      markRead(id);
      if (unreadCount <= 1) setShowProactive(false);
    },
    [markRead, unreadCount]
  );

  const handleReadProactive = useCallback(
    async (id: string) => {
      markRead(id);
      try {
        await markProactiveRead(userId, id);
      } catch {}
    },
    [markRead, userId]
  );

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble message={item} persona={persona} />
    ),
    [persona]
  );

  const buildDispatchDeps = useCallback((): DispatchDeps => ({
    addMessage,
    speak,
    setInputText,
    sendingRef,
    generateId,
    llmStatus,
    getCtx,
    inferLocal,
    phraseWithLLM,
    resolveContactPhone,
    handleCalendarAction,
    handleMapsAction,
    launchAndroidTimer,
    handleLaunchActionRef,
    pendingContactCollectRef,
    pendingMedConfirmRef,
    pendingMedClearRef,
    pendingTodoCompleteRef,
  }), [addMessage, speak, llmStatus, getCtx, inferLocal]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PersonaBackground persona={personaKey}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : "padding"}
          keyboardVerticalOffset={0}
        >
          <View style={styles.header}>
            <Text style={[styles.wordmark, { color: persona.colors.text }]}>
              {aiName || "Herald"}
            </Text>
            <View style={styles.headerRight}>
              {isSpeaking && (
                <TouchableOpacity
                  onPress={stop}
                  style={styles.speakingIndicator}
                  accessibilityLabel="Stop speaking"
                >
                  <View
                    style={[
                      styles.speakingDot,
                      { backgroundColor: persona.colors.accent },
                    ]}
                  />
                </TouchableOpacity>
              )}
              {unreadCount > 0 && (
                <TouchableOpacity
                  onPress={() => setShowProactive((v) => !v)}
                  style={[styles.badge, { backgroundColor: persona.colors.accent }]}
                  accessibilityLabel={`${unreadCount} new alerts`}
                >
                  <Text style={styles.badgeText}>{unreadCount}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {showProactive && proactiveItems.filter((i) => !i.read).length > 0 && (
            <View style={styles.proactivePanel}>
              <View style={styles.proactiveHeader}>
                <Text
                  style={[styles.proactiveTitle, { color: persona.colors.textMuted }]}
                >
                  While you were away
                </Text>
                <TouchableOpacity onPress={markAllRead}>
                  <Text style={[styles.clearAll, { color: persona.colors.accent }]}>
                    Clear all
                  </Text>
                </TouchableOpacity>
              </View>
              {proactiveItems
                .filter((i) => !i.read)
                .slice(0, 3)
                .map((item) => (
                  <ProactiveCard
                    key={item.id}
                    item={item}
                    persona={persona}
                    onRead={handleReadProactive}
                    onDismiss={handleDismissProactive}
                  />
                ))}
            </View>
          )}

          {isOwner && freddieStatus && (
            <View
              style={[
                styles.freddieCard,
                {
                  backgroundColor: persona.colors.accentMuted,
                  borderColor: persona.colors.accent + "30",
                },
              ]}
            >
              <Text style={[styles.freddieLabel, { color: persona.colors.accent }]}>
                FREDDIE
              </Text>
              <Text style={[styles.freddieText, { color: persona.colors.text }]}>
                {freddieStatus.briefing_block}
              </Text>
            </View>
          )}

          {localLLMStatus === 'downloading' && (
            <View style={styles.modelDownloadBanner}>
              <Text
                style={[
                  styles.modelDownloadText,
                  { color: persona.colors.accent },
                ]}
              >
                Setting up voice brain...
              </Text>
            </View>
          )}

          {displayMessages.length === 0 && !isStreaming ? (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyGreeting, { color: persona.colors.text }]}>
                {name ? `Good to see you, ${name}.` : "Good to see you."}
              </Text>
              <Text style={[styles.emptyName, { color: persona.colors.textMuted }]}>
                What's on your mind?
              </Text>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={displayMessages}
              renderItem={renderMessage}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.messageList}
              showsVerticalScrollIndicator={false}
              // ── Scroll snap fix: track position, only auto-scroll at bottom ──
              scrollEventThrottle={100}
              onScroll={({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }) => {
                const distFromBottom =
                  contentSize.height - contentOffset.y - layoutMeasurement.height;
                isAtBottomRef.current = distFromBottom < 80;
              }}
              onContentSizeChange={() => {
                if (isAtBottomRef.current) {
                  flatListRef.current?.scrollToEnd({ animated: false });
                }
              }}
              ListFooterComponent={
                <>
                  {isWaiting && (
                    <View style={styles.typingRow}>
                      <BouncingDots color={persona.colors.accent} />
                      <Text
                        style={[
                          styles.typingText,
                          { color: "rgba(255,255,255,0.6)" },
                        ]}
                      >
                        {thinkingPhrase}
                      </Text>
                    </View>
                  )}
                  {!isWaiting && streamingContent ? (
                    <MessageBubble
                      message={{
                        id: "streaming",
                        role: "assistant",
                        content: streamingContent,
                        timestamp: Date.now(),
                      }}
                      persona={persona}
                    />
                  ) : null}
                </>
              }
            />
          )}

          {error && <Text style={styles.errorText}>{error}</Text>}

          {pendingAction && (
            <IntentCard
              action={pendingAction}
              status={actionStatus}
              persona={persona}
              onConfirm={handleConfirmIntent}
              onDismiss={handleDismissIntent}
            />
          )}

          <View
            style={[
              styles.inputBar,
              {
                backgroundColor: "rgba(0,0,0,0.75)",
                borderTopColor: persona.colors.border,
                paddingBottom: insets.bottom + 10,
              },
            ]}
          >
            <TextInput
              style={[styles.textInput, { color: "#FFFFFF" }]}
              placeholder={isRecording ? "Listening..." : "Ask anything..."}
              placeholderTextColor="rgba(255,255,255,0.45)"
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={2000}
              returnKeyType="send"
              onSubmitEditing={() => {
                if (inputText.trim()) {
                  sendMessage(inputText.trim());
                  setInputText('');
                }
              }}
              blurOnSubmit={false}
              accessibilityLabel="Message input"
              onFocus={() => {
                // Stop Herald speaking when user taps to type.
                // Prevents feedback loop: user corrects → mic hears Herald talking.
                stop();
              }}
            />
            <Animated.View style={{ transform: [{ scale: pulseAnim }], alignItems: 'center' }}>
            <TouchableOpacity
              style={[
                styles.sendBtn,
                {
                  backgroundColor: handsFreeMode
                    ? persona.colors.accent
                    : isRecording
                    ? '#cc3333'
                    : 'transparent',
                  borderWidth: handsFreeMode || isRecording ? 0 : 1,
                  borderColor: persona.colors.accent,
                  marginRight: 6,
                },
              ]}
              onPress={() => {
                if (isStreaming || isWaiting || isSpeaking) return;
                Keyboard.dismiss();
                if (isRecording) {
                  stopRecording();
                } else {
                  // 50ms delay: lets Android layout settle after keyboard dismiss
                  // before speech recognition initialises -- fixes first-tap miss.
                  setTimeout(() => startRecording(), 50);
                }
              }}
              accessibilityLabel={handsFreeMode ? "Stop hands-free mode" : "Start hands-free mode"}
            >
              <Text style={[styles.sendArrow, { color: handsFreeMode || isRecording ? '#fff' : persona.colors.accent }]}>
                {isRecording ? '⏹' : '🎤'}
              </Text>
            </TouchableOpacity>
            {!isRecording && !isStreaming && !isWaiting && (
              <Text style={{
                color: 'rgba(255,255,255,0.35)',
                fontSize: 10,
                marginTop: 2,
                textAlign: 'center',
                letterSpacing: 0.5,
              }}>
                tap to speak
              </Text>
            )}
            </Animated.View>
            <TouchableOpacity
              style={[
                styles.sendBtn,
                {
                  backgroundColor:
                    inputText.trim() && !isStreaming
                      ? persona.colors.accent
                      : persona.colors.border,
                },
              ]}
              onPress={handleSend}
              disabled={!inputText.trim() || isStreaming}
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              <Text style={styles.sendArrow}>↑</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </PersonaBackground>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "android" ? 40 : 12,
    paddingBottom: 8,
  },
  wordmark: { fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  speakingIndicator: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  speakingDot: { width: 10, height: 10, borderRadius: 5, opacity: 0.85 },
  badge: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  badgeText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },

  proactivePanel: { paddingHorizontal: 16, paddingBottom: 4 },
  proactiveHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  proactiveTitle: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  clearAll: { fontSize: 13, fontWeight: "500" },

  freddieCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  freddieLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  freddieText: { fontSize: 13, lineHeight: 18 },

  modelDownloadBanner: {
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  modelDownloadText: {
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
    opacity: 0.85,
  },

  messageList: { paddingTop: 8, paddingBottom: 16 },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyGreeting: {
    fontSize: 28,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 12,
    letterSpacing: -0.3,
    lineHeight: 36,
    color: "#FFFFFF",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  emptyName: {
    fontSize: 17,
    textAlign: "center",
    lineHeight: 24,
    color: "rgba(255,255,255,0.7)",
  },
  errorText: {
    color: "#C4622D",
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 20,
    paddingVertical: 6,
  },

  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    gap: 8,
  },
  textInput: {
    flex: 1,
    fontSize: 17,
    lineHeight: 24,
    maxHeight: 120,
    paddingTop: 8,
    paddingBottom: 8,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  sendArrow: { color: "#FFFFFF", fontSize: 20, fontWeight: "700" },
  typingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 10,
  },
  typingText: { fontSize: 15, fontStyle: "italic" },
});
