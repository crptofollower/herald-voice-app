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
import { useCalendar } from "../hooks/useCalendar";
import { useLocation } from "../hooks/useLocation";
import { useMic } from "../hooks/useMic";
import { useHealthConnect } from "../hooks/useHealthConnect";
import { useDeviceMemory, saveLocalProfile, saveLocalMedical, saveLocalPreference } from "../hooks/useDeviceMemory";
import { answerFromDevice } from '../utils/localAnswers';
import { classifyQuery } from "../routing/tierRouter";
import { handleTier1, buildTier2DeviceContext, writeProfileFromOnboarding } from "../routing/tier1Responses";
import { refreshCalendarCache } from "../db/calendarCacheDB";
import { markCalendarWrite } from "../db/calendarState";
import { initDB } from "../db/useDeviceDB";
import { runMigration } from "../routing/migration";
import { setProfileField, setProfileFields } from "../db/profileDB";
import {
  writeContact,
  resolvePhoneNumber,
  updateLastContact,
  extractContactFromFact,
  findContactByRelationship,
  findContactByName,
} from "../db/contactsDB";
import { writeMedicalFact, writeMedicalRecord, writeMedication, writeMedicalContact } from "../db/medicalDB";
import { drainPendingWrites, getPendingCount, queueWrite } from "../db/pendingWritesDB";
import { _registerContactExtractor, writeFacts } from "../db/factDB";

interface IntentAction {
  type: string;
  value: string;
}

const IDLE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

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

const CALENDAR_QUERY_PATTERNS = [
  /what('s| is) on my calendar/i,
  /what do i have (today|tomorrow|this week)/i,
  /any (appointments|meetings|events) (today|tomorrow)/i,
  /my schedule (today|tomorrow|this week)/i,
  /what('s| is) (scheduled|planned) (today|tomorrow)/i,
];

async function readCalendarDirect(text: string): Promise<string | null> {
  try {
    const { status } = await Calendar.getCalendarPermissionsAsync(); // check only
    if (status !== 'granted') return null;
    const isTomorrow = /tomorrow/i.test(text);
    const isThisWeek = /this week/i.test(text);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (isTomorrow) start.setDate(start.getDate() + 1);
    const end = new Date(start);
    if (isThisWeek) end.setDate(end.getDate() + 7);
    end.setHours(23, 59, 59, 999);
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const events = await Calendar.getEventsAsync(calendars.map(c => c.id), start, end);
    const sorted = events
      .filter(e => e.title)
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
    const dayLabel = isTomorrow ? 'tomorrow' : isThisWeek ? 'this week' : 'today';
    if (sorted.length === 0) return `Your calendar is clear ${dayLabel}.`;
    const lines = sorted.map(e => {
      const t = new Date(e.startDate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return isThisWeek
        ? `${e.title} on ${new Date(e.startDate).toLocaleDateString([], { weekday: 'long' })} at ${t}`
        : `${e.title} at ${t}`;
    });
    return lines.length === 1
      ? `You have ${lines[0]} ${dayLabel}.`
      : `${dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)} you have: ${lines.join(', ')}.`;
  } catch {
    return null;
  }
}

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
  } = useStore();

  const persona = PERSONAS[personaKey] ?? PERSONAS[DEFAULT_PERSONA];

  const [inputText, setInputText] = useState("");
  const [showProactive, setShowProactive] = useState(false);
  const [pendingAction, setPendingAction] = useState<IntentAction | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus>("confirming");

  const [streamingContent, setStreamingContent] = useState("");
  const [isWaiting, setIsWaiting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingPhrase, setThinkingPhrase] = useState(THINKING_PHRASES[0]);

  // ── Ambient mode state ────────────────────────────────────────────────────
  // sessionStart filters which messages are shown in the current session.
  // Old messages stay in the store for API context but aren't rendered.
  const [sessionStart, setSessionStart] = useState(() => Date.now());
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
  const autoOpenAppsRef = useRef(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const tokenBatchRef = useRef<string>('');
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Scroll snap prevention ────────────────────────────────────────────────
  // Only auto-scroll to bottom when user is already near the bottom.
  // If they've scrolled up to read (Freddie response etc.), leave them there.
  const isAtBottomRef = useRef(true);

  const { speak, enqueueSentence, resetSpeech, stop, isSpeaking } = useSpeech();
  const [handsFreeMode, setHandsFreeMode] = useState(false);
  const handsFreeRef = useRef(false);
  useProactiveQueue();
  useCalendar();
  // useHealthConnect(); // disabled until AndroidManifest entries added
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
                await handleCalendarAction(payload.value, payload.context ?? '');
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
    AsyncStorage.getItem('auto_open_apps').then(val => {
      if (val === 'true') autoOpenAppsRef.current = true;
    });
  }, []);

  // ── Session L: init device SQLite and run one-time migration ─────────────
  useEffect(() => {
    if (!userId) return;
    initDB().then(async () => {
      runMigration(userId);
      refreshCalendarCache();

      // Register contact extractor so relationship facts auto-populate contacts table
      _registerContactExtractor(extractContactFromFact);

      // Wire core identity to local_profile SQLite table
      const store = useStore.getState();
      const profileWrites: Record<string, string> = {};
      if (store.name)    profileWrites.name    = store.name;
      if (store.aiName)  profileWrites.ai_name = store.aiName;
      if (store.persona) profileWrites.persona  = store.persona;
      if (userId)        profileWrites.user_id  = userId;
      if (Object.keys(profileWrites).length > 0) {
        setProfileFields(profileWrites);
      }

      // Drain any writes queued while offline — calendar events, SMS etc.
      const pending = getPendingCount();
      if (pending > 0) {
        drainPendingWrites(async (write) => {
          const payload = JSON.parse(write.payload);
          if (write.type === 'calendar') {
            await handleCalendarAction(payload.value, payload.context ?? '');
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
    }).catch(() => {});
  }, [userId]);

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
            if (greetingLabel) {
              saveDeviceProfile("confirmed_city", greetingLabel);
              // Mirror to local_profile SQLite — makes Tier 1 profile queries work
              setProfileField("city", greetingLabel);
            }
          }
        })
        .catch(() => {});
    },
    [userId, addMessage, setMessages, saveDeviceProfile]
  );

  // ── Greeting on first open ────────────────────────────────────────────────
  // Use displayMessages not messages -- old sessions have messages.length > 0
  // but displayMessages is always empty on mount (sessionStart = Date.now()).
  useEffect(() => {
    if (!userId || displayMessages.length > 0) return;
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
  }, [userId, available, lat, lng, locationLabel, displayMessages.length, getLocalGreeting, aiName, addMessage, speak, upgradeLiveGreeting]);

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
  }, [available, userId, lat, lng]);

  // ── Auto-scroll (only when user is at bottom) ─────────────────────────────
  useEffect(() => {
    if ((displayMessages.length > 0 || streamingContent) && isAtBottomRef.current) {
      flatListRef.current?.scrollToEnd({ animated: false });
    }
  }, [displayMessages.length, streamingContent]);

  // ── Send ──────────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (text: string) => {
    const now = Date.now();
    if (now - lastSentRef.current < 1000) return;
    if (sendingRef.current) return;
    if (!text) return;

    lastSentRef.current = now;
    sendingRef.current = true;
    const historySnapshot = messages.map(({ role, content }) => ({ role, content }));

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const _autoOpenTriggers = [
      "just open it", "stop asking", "open it directly", "just open",
      "don't ask", "dont ask", "open without asking", "just do it",
      "open it when i ask", "open when i ask", "just launch it",
    ];
    if (_autoOpenTriggers.some(t => text.toLowerCase().includes(t))) {
      autoOpenAppsRef.current = true;
      AsyncStorage.setItem('auto_open_apps', 'true');
    }

    // ── Offline check -- skip network, answer from device or give warm message ──
    const networkState = await Network.getNetworkStateAsync();
    const isOffline = !networkState.isConnected || !networkState.isInternetReachable;
    if (isOffline) {
      if (CALENDAR_QUERY_PATTERNS.some((p) => p.test(text))) {
        const calAnswer = await readCalendarDirect(text);
        if (calAnswer) {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          addMessage({ id: generateId('msg'), role: 'assistant', content: calAnswer, timestamp: Date.now() });
          speak(calAnswer);
          setInputText('');
          sendingRef.current = false;
          return;
        }
      }
      // Try device memory next
      const localAnswer = answerFromDevice(text);
      const offlineReply = localAnswer ??
        "I'm offline right now, but I can still help — ask me about your calendar, schedule, medications, or anything personal.";
      addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
      addMessage({ id: generateId('msg'), role: 'assistant', content: offlineReply, timestamp: Date.now() });
      speak(offlineReply);
      setInputText('');
      sendingRef.current = false;
      return;
    }

    // ── Calendar on-device -- read expo-calendar directly, zero network ────
    if (CALENDAR_QUERY_PATTERNS.some((p) => p.test(text))) {
      const calAnswer = await readCalendarDirect(text);
      if (calAnswer) {
        addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
        addMessage({ id: generateId('msg'), role: 'assistant', content: calAnswer, timestamp: Date.now() });
        speak(calAnswer);
        setInputText('');
        sendingRef.current = false;
        return;
      }
    }

    // ── Tier router — device-first before any network call ───────────────────
    // Tier 1: answer from device SQLite, no LLM, no network, under 200ms.
    // Tier 2: memory probe — attach structured local context to backend request.
    // Tier 3: default — existing network path unchanged.
    const tierDecision = await classifyQuery(text);

    if (tierDecision.tier === 1 && tierDecision.tier1Response) {
      handleTier1(tierDecision.tier1Response, text, addMessage, speak, generateId);
      sendingRef.current = false;
      setInputText("");
      return;
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
    speak(_bridgePhrase, { rate: 0.95 });

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

    const abortController = askHeraldStream(
      {
        user_id: userId,
        message: text,
        history: historySnapshot,
        local_time,
        local_date,
        device_context: tierDecision.tier === 2 && tierDecision.localContext
          ? buildTier2DeviceContext(tierDecision.localContext)
          : getContextBlock() || undefined,
        persona: personaKey,
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        location_label: locationLabel ?? undefined,
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
          if (autoOpenAppsRef.current && action.type === "launch") {
            executeIntent(action as IntentAction);
            return;
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

            if (fact.category === 'medication') {
              // Both legacy hook (AsyncStorage) and new medicalDB (SQLite)
              saveLocalMedical('medication', fact.value);
              writeMedicalFact('medication', fact.value);
            } else if (fact.category === 'medical' || fact.category === 'visit') {
              saveLocalMedical('visit', fact.value);
              writeMedicalFact('medical', fact.value);
            } else if (fact.category === 'relationships') {
              // Contact extraction handled by _registerContactExtractor in writeFacts
              saveDeviceMemory(fact.value, fact.category);
            } else if (['food', 'sports', 'music'].includes(fact.category)) {
              saveLocalPreference(fact.category, fact.value);
            } else {
              saveDeviceMemory(fact.value, fact.category);
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
            const _memCat = /medication|prescription|pill|dose|pharmacy/i.test(text) ? 'medication'
              : /doctor|hospital|clinic|surgery|diagnosis|symptom|appointment/i.test(text) ? 'medical'
              : /wife|husband|daughter|son|mom|dad|brother|sister|family|father|mother/i.test(text) ? 'family'
              : /bank|invest|mortgage|savings|debt|401k|retire|money/i.test(text) ? 'finance'
              : /work|job|boss|client|project|meeting|career/i.test(text) ? 'work'
              : /flight|hotel|trip|travel|vacation|airport/i.test(text) ? 'travel'
              : /score|game|team|nfl|nba|mlb|nhl|espn/i.test(text) ? 'sports'
              : /eat|restaurant|food|dinner|lunch|breakfast|coffee/i.test(text) ? 'food'
              : 'general';
            const _memFact = extractFact(text, fullText, _memCat);
            if (_memFact) saveDeviceMemory(_memFact, _memCat);
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
  }, [userId, messages, personaKey, lat, lng, locationLabel, getContextBlock, addMessage, setError, resetSpeech, enqueueSentence, resetStreamState, stop]);

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
                content: `I couldn't find a number for ${rawVal}. The dialer is open — or tell me their number and I'll save it.`,
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

          // Correct Android SET_ALARM intent format
          const alarmUrl = `intent:#Intent;action=android.intent.action.SET_ALARM;S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(alarmLabel)};i.android.intent.extra.alarm.HOUR=${alarmHour};i.android.intent.extra.alarm.MINUTES=${alarmMins};B.android.intent.extra.alarm.SKIP_UI=false;end`;

          // Samsung Clock direct fallback
          const samsungUrl = `intent:#Intent;action=android.intent.action.SET_ALARM;package=com.samsung.android.clockpackage;S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(alarmLabel)};i.android.intent.extra.alarm.HOUR=${alarmHour};i.android.intent.extra.alarm.MINUTES=${alarmMins};B.android.intent.extra.alarm.SKIP_UI=false;end`;

          // Generic clock app last resort
          const clockUrl = `intent:#Intent;action=android.intent.action.SHOW_ALARMS;end`;

          let opened = false;
          try {
            await Linking.openURL(alarmUrl);
            opened = true;
          } catch {
            try {
              await Linking.openURL(samsungUrl);
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

    // Check network — queue for later if offline
    const _calNetState = await Network.getNetworkStateAsync();
    const _calOffline = !_calNetState.isConnected || !_calNetState.isInternetReachable;
    if (_calOffline) {
      queueWrite('calendar', { value, context: conversationContext });
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content: `You're offline right now. I've saved "${title}" and I'll add it to your calendar when you're back online.`,
        timestamp: Date.now(),
      });
      return;
    }

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
    let destination = query;

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

    const encoded = encodeURIComponent(destination);
    const googleApp = `comgooglemaps://?q=${encoded}`;
    const googleWeb = `https://maps.google.com/maps?q=${encoded}`;
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
    } catch {
      // expo-contacts not installed or permission denied — silent
    }

    return null;
  };

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
      queueWrite('sms', {
        phone: resolved?.phone ?? '',
        body: messageText,
        contactName: resolved?.name ?? contactRaw,
      });
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content: `You're offline right now. I've saved that message to ${resolved?.name ?? contactRaw} and I'll send it when you're back online.`,
        timestamp: Date.now(),
      });
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

  const handleLaunchAction = async (appName: string) => {
    const key = appName.toLowerCase().trim().replace(/\s+/g, "");
    const launchApps: Record<string, { deep: string | string[]; fallback?: string }> = {
      youtube: { deep: "youtube://", fallback: "https://youtube.com" },
      tiktok: { deep: "tiktok://", fallback: "https://tiktok.com" },
      twitter: { deep: "twitter://", fallback: "https://twitter.com" },
      x: { deep: "twitter://", fallback: "https://twitter.com" },
      instagram: { deep: "instagram://", fallback: "https://instagram.com" },
      health: { deep: "com.sec.android.app.shealth://" },
      shealth: { deep: "com.sec.android.app.shealth://" },
      samsunghealth: { deep: "com.sec.android.app.shealth://" },
      walking: { deep: "com.sec.android.app.shealth://" },
      workout: { deep: "com.sec.android.app.shealth://" },
      steps: { deep: "com.sec.android.app.shealth://" },
      spotify: { deep: "spotify://", fallback: "https://open.spotify.com" },
      facebook: { deep: "intent:#Intent;action=android.intent.action.VIEW;package=com.facebook.katana;end", fallback: "https://facebook.com" },
      googlemaps: { deep: "comgooglemaps://", fallback: "https://maps.google.com" },
      maps: { deep: "comgooglemaps://", fallback: "https://maps.google.com" },
      gmail: { deep: "googlegmail://", fallback: "https://mail.google.com" },
      healthconnect: { deep: "com.google.android.apps.healthdata://" },
      linkedin: { deep: "linkedin://", fallback: "https://linkedin.com" },
      pinterest: { deep: "pinterest://", fallback: "https://pinterest.com" },
      truthsocial: { deep: "truthsocial://", fallback: "https://truthsocial.com" },
      uber: { deep: "uber://", fallback: "https://uber.com" },
      lyft: { deep: "lyft://", fallback: "https://lyft.com" },
      doordash: { deep: "doordash://", fallback: "https://doordash.com" },
      ubereats: { deep: "ubereats://", fallback: "https://ubereats.com" },
      chilis: { deep: "chilis://", fallback: "https://chilis.com" },
      starbucks: { deep: "starbucks://", fallback: "https://starbucks.com" },
      chipotle: { deep: "chipotle://", fallback: "https://chipotle.com" },
      amazon: { deep: "amazon://", fallback: "https://amazon.com" },
      walmart: { deep: "walmart://", fallback: "https://walmart.com" },
      target: { deep: "target://", fallback: "https://target.com" },
      bestbuy: { deep: "bestbuy://", fallback: "https://bestbuy.com" },
      costco: { deep: "costco://", fallback: "https://costco.com" },
      samsclub: { deep: "samsclub://", fallback: "https://samsclub.com" },
      yelp: { deep: "yelp://", fallback: "https://yelp.com" },
      americanairlines: { deep: "americanairlines://", fallback: "https://aa.com" },
      aa: { deep: "americanairlines://", fallback: "https://aa.com" },
      delta: { deep: "fly-delta://", fallback: "https://delta.com" },
      southwest: { deep: "southwest://", fallback: "https://southwest.com" },
      united: { deep: "united://", fallback: "https://united.com" },
      airbnb: { deep: "airbnb://", fallback: "https://airbnb.com" },
      hotels: { deep: "hotels://", fallback: "https://hotels.com" },
      hilton: { deep: "hilton://", fallback: "https://hilton.com" },
      marriott: { deep: "marriott://", fallback: "https://marriott.com" },
      hyatt: { deep: "world://", fallback: "https://hyatt.com" },
      ihg: { deep: "ihg://", fallback: "https://ihg.com" },
      hertz: { deep: "hertz://", fallback: "https://hertz.com" },
      enterprise: { deep: "enterprise://", fallback: "https://enterprise.com" },
      avis: { deep: "avis://", fallback: "https://avis.com" },
      nationalcar: { deep: "nationalcar://", fallback: "https://nationalcar.com" },
      budget: { deep: "budget://", fallback: "https://budget.com" },
      tripadvisor: { deep: "tripadvisor://", fallback: "https://tripadvisor.com" },
      netflix: { deep: "netflix://", fallback: "https://netflix.com" },
      hulu: { deep: "hulu://", fallback: "https://hulu.com" },
      amc: { deep: "amc://", fallback: "https://amctheatres.com" },
      fandango: { deep: "fandango://", fallback: "https://fandango.com" },
      cvs: { deep: "cvs://", fallback: "https://cvs.com" },
      walgreens: { deep: "walgreens://", fallback: "https://walgreens.com" },
      mychart: { deep: "epicmychart://", fallback: "https://mychart.com" },
      chase: { deep: "chase://", fallback: "https://chase.com" },
      bankofamerica: { deep: "bofa://", fallback: "https://bankofamerica.com" },
      wellsfargo: { deep: "wellsfargo://", fallback: "https://wellsfargo.com" },
      amex: { deep: "amex://", fallback: "https://americanexpress.com" },
      americanexpress: { deep: "amex://", fallback: "https://americanexpress.com" },
      bofa: { deep: "bofa://", fallback: "https://bankofamerica.com" },
      aarp: { deep: "aarp://", fallback: "https://aarp.org" },
      googlephotos:  { deep: "googlephotos://", fallback: "https://photos.google.com" },
      photos:        { deep: "googlephotos://", fallback: "https://photos.google.com" },
      photoalbum:    { deep: "googlephotos://", fallback: "https://photos.google.com" },
      myphotoalbum:  { deep: "googlephotos://", fallback: "https://photos.google.com" },
      myphotos:      { deep: "googlephotos://", fallback: "https://photos.google.com" },
      gallery:       { deep: "intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.sec.android.gallery3d;end", fallback: "https://photos.google.com" },
      // System apps
      settings:      { deep: "intent:#Intent;action=android.settings.SETTINGS;end" },
      camera:        {
        deep: [
          "intent:#Intent;action=android.media.action.IMAGE_CAPTURE;package=com.sec.android.app.camera;end",
          "intent:#Intent;action=android.media.action.IMAGE_CAPTURE;end",
        ],
      },
      dialer:        { deep: "intent:#Intent;action=android.intent.action.DIAL;end" },
      phone:         { deep: "intent:#Intent;action=android.intent.action.DIAL;end" },
      calculator:    { deep: "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.APP_CALCULATOR;end" },
      files:         { deep: "intent:#Intent;action=android.intent.action.VIEW;type=resource/folder;end" },
      // Samsung specific
      samsungpay:    { deep: "samsungpay://", fallback: "https://www.samsung.com/us/samsung-pay/" },
      samsungwallet: { deep: "samsungpay://", fallback: "https://www.samsung.com/us/samsung-pay/" },
      bixby:         { deep: "bixby://", fallback: "" },
      // Additional streaming
      disneyplus:    { deep: "disneyplus://", fallback: "https://disneyplus.com" },
      hbomax:        { deep: "hbomax://", fallback: "https://max.com" },
      max:           { deep: "hbomax://", fallback: "https://max.com" },
      peacock:       { deep: "peacocktv://", fallback: "https://peacocktv.com" },
      paramountplus: { deep: "paramountplus://", fallback: "https://paramountplus.com" },
      appletv:       { deep: "videos://", fallback: "https://tv.apple.com" },
      // Pharmacy / health
      express_scripts: { deep: "expressscripts://", fallback: "https://express-scripts.com" },
      goodrx:        { deep: "goodrx://", fallback: "https://goodrx.com" },
      // News
      cnn:           { deep: "cnn://", fallback: "https://cnn.com" },
      foxnews:       { deep: "foxnews://", fallback: "https://foxnews.com" },
      espn:          { deep: "sportscenter://", fallback: "https://espn.com" },
      // Productivity
      googledocs:    { deep: "googledocs://", fallback: "https://docs.google.com" },
      googledrive:   { deep: "googledrive://", fallback: "https://drive.google.com" },
      zoom:          { deep: "zoomus://", fallback: "https://zoom.us" },
      teams:         { deep: "msteams://", fallback: "https://teams.microsoft.com" },
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

  const handleConfirmIntent = useCallback(async () => {
    if (!pendingAction || actionStatus === "executing") return;
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PersonaBackground persona={personaKey}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
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
