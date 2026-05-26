// src/screens/ChatScreen.tsx — Herald main interface
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
import { useDeviceMemory, saveLocalProfile } from "../hooks/useDeviceMemory";
import { answerFromDevice } from '../utils/localAnswers';

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
  "Good question, one sec...",
  "On it...",
  "Let me look that up...",
  "Checking on that...",
  "Give me a second...",
  "Working on it...",
  "One moment...",
  "Looking into it...",
  "Hang tight...",
  "Right on it...",
  "Let me think through that...",
];

export default function ChatScreen() {
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

  useEffect(() => {
    if (!isWaiting) return;
    let index = 0;
    const interval = setInterval(() => {
      index = (index + 1) % THINKING_PHRASES.length;
      setThinkingPhrase(THINKING_PHRASES[index]);
    }, 1800);
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
      // Try calendar first (async, needs expo-calendar)
      const calPatterns = [
        /what('s| is) on my calendar/i,
        /what do i have (today|tomorrow|this week)/i,
        /any (appointments|meetings|events) (today|tomorrow)/i,
        /my schedule (today|tomorrow|this week)/i,
        /what('s| is) (scheduled|planned) (today|tomorrow)/i,
      ];
      if (calPatterns.some((p) => p.test(text))) {
        try {
          const calPerms = await Calendar.getCalendarPermissionsAsync();
          if (calPerms.status === 'granted') {
            const isTomorrow = /tomorrow/i.test(text);
            const isThisWeek = /this week/i.test(text);
            const start = new Date(); start.setHours(0,0,0,0);
            const end = new Date(start);
            if (isThisWeek) { end.setDate(end.getDate() + 7); }
            else if (isTomorrow) { start.setDate(start.getDate() + 1); end.setDate(end.getDate() + 1); }
            end.setHours(23,59,59,999);
            const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
            const events = await Calendar.getEventsAsync(calendars.map(c => c.id), start, end);
            const sorted = events.filter(e => e.title).sort((a,b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
            const dayLabel = isTomorrow ? 'tomorrow' : isThisWeek ? 'this week' : 'today';
            const calAnswer = sorted.length === 0
              ? `Your calendar is clear ${dayLabel}.`
              : sorted.length === 1
                ? `You have ${sorted[0].title} at ${new Date(sorted[0].startDate).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} ${dayLabel}.`
                : `${dayLabel.charAt(0).toUpperCase()+dayLabel.slice(1)} you have: ${sorted.map(e=>`${e.title} at ${new Date(e.startDate).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`).join(', ')}.`;
            addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
            addMessage({ id: generateId('msg'), role: 'assistant', content: calAnswer, timestamp: Date.now() });
            speak(calAnswer);
            setInputText('');
            sendingRef.current = false;
            return;
          }
        } catch { /* fall through */ }
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
    const calendarPatterns = [
      /what('s| is) on my calendar/i,
      /what do i have (today|tomorrow|this week)/i,
      /any (appointments|meetings|events) (today|tomorrow)/i,
      /my schedule (today|tomorrow|this week)/i,
      /what('s| is) (scheduled|planned) (today|tomorrow)/i,
    ];
    if (calendarPatterns.some((p) => p.test(text))) {
      try {
        const calPerms = await Calendar.getCalendarPermissionsAsync();
        if (calPerms.status === 'granted') {
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          const isTomorrow = /tomorrow/i.test(text);
          const isThisWeek = /this week/i.test(text);
          const end = new Date(start);
          if (isThisWeek) {
            end.setDate(end.getDate() + 7);
          } else if (isTomorrow) {
            start.setDate(start.getDate() + 1);
            end.setDate(end.getDate() + 1);
          }
          end.setHours(23, 59, 59, 999);
          const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
          const calIds = calendars.map((c) => c.id);
          const events = await Calendar.getEventsAsync(calIds, start, end);
          const sorted = events
            .filter((e) => e.title)
            .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
          const dayLabel = isTomorrow ? 'tomorrow' : isThisWeek ? 'this week' : 'today';
          let calAnswer: string;
          if (sorted.length === 0) {
            calAnswer = `Your calendar is clear ${dayLabel}.`;
          } else {
            const lines = sorted.map((e) => {
              const t = new Date(e.startDate).toLocaleTimeString([], {
                hour: 'numeric', minute: '2-digit',
              });
              return isThisWeek
                ? `${e.title} on ${new Date(e.startDate).toLocaleDateString([], { weekday: 'long' })} at ${t}`
                : `${e.title} at ${t}`;
            });
            calAnswer = lines.length === 1
              ? `You have ${lines[0]} ${dayLabel}.`
              : `${dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)} you have: ${lines.join(', ')}.`;
          }
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          addMessage({ id: generateId('msg'), role: 'assistant', content: calAnswer, timestamp: Date.now() });
          speak(calAnswer);
          setInputText('');
          sendingRef.current = false;
          return;
        }
      } catch {
        // fall through to network
      }
    }

    // ── Device-first interceptor -- answer personal queries from SQLite ──────
    // Zero network. Zero OpenRouter cost. Under 200ms. Works offline.
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
    sendingRef.current = true;

    addMessage({
      id: generateId("msg"),
      role: "user",
      content: text,
      timestamp: now,
    });

    setError(null);
    setPendingAction(null);
    resetSpeech();
    const _bridgePhrases = [
      "One second, let me get that...",
      "Good question, hang on...",
      "Let me find that for you...",
      "On it, give me a sec...",
      "Right on it...",
      "Give me just a moment...",
    ];
    speak(
      _bridgePhrases[Math.floor(Math.random() * _bridgePhrases.length)],
      { rate: 0.95 }
    );

    setIsWaiting(true);
    setIsStreaming(true);
    setStreamingContent("");
    isAtBottomRef.current = true;

    let firstToken = true;

    // v8.15.1: Send device local time so backend answers "what time is it"
    // correctly. Railway runs UTC -- without this the answer is 5 hours off.
    const nowDate = new Date();
    const local_time = nowDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const local_date = [
      nowDate.getFullYear(),
      String(nowDate.getMonth() + 1).padStart(2, "0"),
      String(nowDate.getDate()).padStart(2, "0"),
    ].join("-");

    const abortController = askHeraldStream(
      {
        user_id: userId,
        message: text,
        history: messages.map(({ role, content }) => ({ role, content })),
        local_time,
        local_date,
        device_context: getContextBlock() || undefined,
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
            flatListRef.current?.scrollToEnd({ animated: false });
            const maxStreamTimer = setTimeout(() => {
              if (streamAbortRef.current) {
                streamAbortRef.current.abort();
                resetStreamState();
                setError('Response timed out. Try again.');
              }
            }, 60_000);
            if (streamAbortRef.current) {
              (streamAbortRef.current as any)._maxTimer = maxStreamTimer;
            }
          }
          setStreamingContent((prev) => prev + token);
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
        onDone: (fullText) => {
          if (fullText.trim()) {
            addMessage({ id: generateId("msg"), role: "assistant", content: fullText, timestamp: Date.now() });
            saveDeviceMemory(`Conversation: ${text.slice(0, 80)} → ${fullText.slice(0, 120)}`, 'conversation');
          }
          resetStreamState();
        },
        onError: (err) => { setError(err.message); resetStreamState(); },
      }
    );

    streamAbortRef.current = abortController;
    setInputText("");
  }, [userId, messages, personaKey, lat, lng, locationLabel, getContextBlock, addMessage, setError, resetSpeech, enqueueSentence, resetStreamState]);

  const handleSend = useCallback(() => {
    sendMessage(inputText.trim());
  }, [inputText, sendMessage]);

  const handleTranscript = useCallback((transcript: string) => {
    if (!transcript.trim()) return;
    sendMessage(transcript.trim());
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
        case "phone":
          await Linking.openURL(`tel:${action.value.replace(/\D/g, "")}`);
          break;
        case "flights":
          await Linking.openURL(
            `https://www.google.com/flights?q=${encodeURIComponent(action.value)}`
          );
          break;
        case "search":
          await Linking.openURL(
            `https://www.google.com/search?q=${encodeURIComponent(action.value)}`
          );
          break;
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
  };

  const handleMapsAction = async (query: string) => {
    const encoded = encodeURIComponent(query);
    const googleApp = `comgooglemaps://?q=${encoded}`;
    const googleWeb = `https://maps.google.com/maps?q=${encoded}`;
    try {
      const canGoogle = await Linking.canOpenURL(googleApp);
      await Linking.openURL(canGoogle ? googleApp : googleWeb);
    } catch {
      await Linking.openURL(googleWeb);
    }
  };

  const handleSMSAction = async (value: string) => {
    const pipeIdx = value.indexOf("|");
    const contactName = pipeIdx >= 0 ? value.substring(0, pipeIdx).trim() : value.trim();
    const messageText = pipeIdx >= 0 ? value.substring(pipeIdx + 1).trim() : "";
    const body = encodeURIComponent(messageText);
    const smsUrl = Platform.OS === "ios" ? `sms:&body=${body}` : `sms:?body=${body}`;
    await Linking.openURL(smsUrl);
    if (contactName) {
      addMessage({
        id: generateId("msg"),
        role: "assistant",
        content: `Your messages app is open with that ready. Just pick ${contactName} and hit send.`,
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
      facebook: { deep: "fb://", fallback: "https://facebook.com" },
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
      amazon: { deep: "amazon://", fallback: "https://amazon.com" },
      walmart: { deep: "walmart://", fallback: "https://walmart.com" },
      costco: { deep: "costco://", fallback: "https://costco.com" },
      samsclub: { deep: "samsclub://", fallback: "https://samsclub.com" },
      yelp: { deep: "yelp://", fallback: "https://yelp.com" },
      americanairlines: { deep: "americanairlines://", fallback: "https://aa.com" },
      delta: { deep: "fly-delta://", fallback: "https://delta.com" },
      southwest: { deep: "southwest://", fallback: "https://southwest.com" },
      united: { deep: "united://", fallback: "https://united.com" },
      airbnb: { deep: "airbnb://", fallback: "https://airbnb.com" },
      hotels: { deep: "hotels://", fallback: "https://hotels.com" },
      hertz: { deep: "hertz://", fallback: "https://hertz.com" },
      enterprise: { deep: "enterprise://", fallback: "https://enterprise.com" },
      tripadvisor: { deep: "tripadvisor://", fallback: "https://tripadvisor.com" },
      netflix: { deep: "netflix://", fallback: "https://netflix.com" },
      hulu: { deep: "hulu://", fallback: "https://hulu.com" },
      amc: { deep: "amc://", fallback: "https://amctheatres.com" },
      fandango: { deep: "fandango://", fallback: "https://fandango.com" },
      cvs: { deep: "cvs://", fallback: "https://cvs.com" },
      walgreens: { deep: "walgreens://", fallback: "https://walgreens.com" },
      mychart: { deep: "epicmychart://", fallback: "https://mychart.com" },
      aarp: { deep: "aarp://", fallback: "https://aarp.org" },
      googlephotos: { deep: "googlephotos://", fallback: "https://photos.google.com" },
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
              },
            ]}
          >
            <TextInput
              style={[styles.textInput, { color: "#FFFFFF" }]}
              placeholder="Ask anything..."
              placeholderTextColor="rgba(255,255,255,0.45)"
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={2000}
              returnKeyType="default"
              blurOnSubmit={false}
              accessibilityLabel="Message input"
              onFocus={() => {
                // Stop Herald speaking when user taps to type.
                // Prevents feedback loop: user corrects → mic hears Herald talking.
                stop();
              }}
            />
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
                if (handsFreeMode) {
                  setHandsFreeMode(false);
                  stopRecording();
                } else {
                  Keyboard.dismiss();
                  setHandsFreeMode(true);
                  startRecording();
                }
              }}
              accessibilityLabel={handsFreeMode ? "Stop hands-free mode" : "Start hands-free mode"}
            >
              <Text style={[styles.sendArrow, { color: handsFreeMode || isRecording ? '#fff' : persona.colors.accent }]}>
                {isRecording ? '⏹' : '🎤'}
              </Text>
            </TouchableOpacity>
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
    paddingBottom: Platform.OS === "ios" ? 10 : 52,  // 52 clears Android gesture nav bar
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
