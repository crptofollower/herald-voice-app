// src/screens/ChatScreen.tsx -- Herald main interface
//
// FIXES APPLIED (May 12 2026):
//
//   Bug 10 follow-on: useStore no longer exposes isLoading or setLoading
//   (removed in the Bug 10 fix to eliminate the Zustand / React Query desync).
//   ChatScreen was still destructuring both and calling setLoading() — this
//   caused a TypeScript compile error and a runtime crash on every send.
//   Fix: remove isLoading + setLoading entirely; sendMutation.isPending is
//   the single source of truth for in-flight state throughout this component.
//
//   generateId extracted to src/utils/id.ts — identical behaviour, shared impl.
//
// NO FUNCTIONAL CHANGES beyond the above two fixes.

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
} from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  SafeAreaView,
} from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useStore } from "../store/useStore";
import { PERSONAS } from "../constants/personas";
import { askHerald, markProactiveRead, fetchGreeting, type Message } from "../api/herald";
import { useSpeech } from "../hooks/useSpeech";
import { useProactiveQueue } from "../hooks/useProactiveQueue";

import { PersonaBackground } from "../components/PersonaBackground";
import { MessageBubble } from "../components/MessageBubble";
import { ProactiveCard } from "../components/ProactiveCard";
import { generateId } from "../utils/id"; // ← extracted from inline def
import { useCalendar } from "../hooks/useCalendar";
import { useHealthData } from "../hooks/useHealthData";
import { useLocation } from "../hooks/useLocation";
export default function ChatScreen() {
  // ─── Store ─────────────────────────────────────────────────────────────────
  // isLoading + setLoading REMOVED — these no longer exist in useStore.
  // Use sendMutation.isPending for all in-flight state checks in this file.
  const {
    userId,
    name,
    persona: personaKey,
    messages,
    addMessage,
    setError,
    error,
    items: proactiveItems,
    unreadCount,
    markRead,
    markAllRead,
    isOwner,
    status: freddieStatus,
  } = useStore();

  const persona = PERSONAS[personaKey];

  // ─── Local UI state ────────────────────────────────────────────────────────
  const [inputText, setInputText]         = useState("");
  const [showProactive, setShowProactive] = useState(false);
  const flatListRef  = useRef<FlatList>(null);
  const sendingRef   = useRef(false); // double-send guard

  // ─── Hooks ─────────────────────────────────────────────────────────────────
  const { speak, stop, isSpeaking } = useSpeech();
  useProactiveQueue(); // polls /proactive on open + resume, debounced
useCalendar();
    const { lat, lng, label: locationLabel } = useLocation();
  // Show proactive panel when new items arrive.
  useEffect(() => {
    if (unreadCount > 0) setShowProactive(true);
  }, [unreadCount]);
// Fire greeting once on first open (no messages yet).
  useEffect(() => {
    if (!userId || messages.length > 0) return;
    const local_time = new Date().toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    fetchGreeting({
      user_id: userId,
      local_time,
      lat:            lat ?? undefined,
      lng:            lng ?? undefined,
      location_label: locationLabel ?? undefined,
    })
      .then((data) => {
        if (!data.greeting) return;
        addMessage({
          id: generateId("msg"),
          role: "assistant",
          content: data.greeting,
          timestamp: Date.now(),
        });
        speak(data.greeting);
      })
      .catch(() => { /* non-critical -- static empty state handles it */ });
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Scroll to bottom whenever the message list grows.
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(
        () => flatListRef.current?.scrollToEnd({ animated: true }),
        100
      );
    }
  }, [messages.length]);

  // ─── Send mutation ─────────────────────────────────────────────────────────
  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      // Optimistic: add the user message to the list immediately so the UI
      // feels instant. The server response will append the assistant message.
      const userMsg: Message = {
        id:        generateId("msg"),
        role:      "user",
        content:   text,
        timestamp: Date.now(),
      };
      addMessage(userMsg);

      return askHerald({
        user_id: userId,
        message: text,
        history: messages.map(({ role, content }) => ({ role, content })),
        persona: personaKey,
        lat:            lat ?? undefined,
        lng:            lng ?? undefined,
        location_label: locationLabel ?? undefined,
      });
    },
    onSuccess: (data) => {
      const heraldMsg: Message = {
        id:        generateId("msg"),
        role:      "assistant",
        content:   data.reply,
        timestamp: Date.now(),
      };
      addMessage(heraldMsg);
      speak(data.reply);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
    // onSettled: setLoading(false) — REMOVED (Bug 10 fix)
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || sendMutation.isPending || sendingRef.current) return;
    sendingRef.current = true;
    setTimeout(() => { sendingRef.current = false; }, 1000);
    setInputText("");
    setError(null);
    stop();
    sendMutation.mutate(text);
  }, [inputText, sendMutation, setError, stop]);

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
      } catch {
        // Best effort — the local mark is the user-facing state; server sync
        // failing silently is acceptable for proactive notifications.
      }
    },
    [markRead, userId]
  );

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble message={item} persona={persona} />
    ),
    [persona]
  );

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <PersonaBackground persona={personaKey}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          {/* ── Header ──────────────────────────────────────────────────── */}
          <View style={styles.header}>
            <Text style={[styles.wordmark, { color: persona.colors.text }]}>
              Herald
            </Text>
            <View style={styles.headerRight}>
              {isSpeaking && (
                <TouchableOpacity
                  onPress={stop}
                  style={styles.speakingDot}
                  accessibilityLabel="Stop speaking"
                >
                  <ActivityIndicator size="small" color={persona.colors.accent} />
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

          {/* ── Proactive panel ─────────────────────────────────────────── */}
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

          {/* ── Freddie status card (owner only) ────────────────────────── */}
          {isOwner && freddieStatus && (
            <View
              style={[
                styles.freddieCard,
                {
                  backgroundColor: persona.colors.accentMuted,
                  borderColor:     persona.colors.accent + "30",
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

          {/* ── Message list / empty state ──────────────────────────────── */}
          {messages.length === 0 && !sendMutation.isPending ? (
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
              data={messages}
              renderItem={renderMessage}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.messageList}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() =>
                flatListRef.current?.scrollToEnd({ animated: false })
              }
              ListFooterComponent={
                sendMutation.isPending ? (
                  <View style={styles.typingRow}>
                    <ActivityIndicator size="small" color={persona.colors.accent} />
                    <Text style={[styles.typingText, { color: "rgba(255,255,255,0.6)" }]}>
                      Herald is thinking...
                    </Text>
                  </View>
                ) : null
              }
            />
          )}

          {/* ── Error banner ────────────────────────────────────────────── */}
          {error && <Text style={styles.errorText}>{error}</Text>}

          {/* ── Input bar ───────────────────────────────────────────────── */}
          <View
            style={[
              styles.inputBar,
              {
                backgroundColor: "rgba(0,0,0,0.75)",
                borderTopColor:  persona.colors.border,
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
            />
            <TouchableOpacity
              style={[
                styles.sendBtn,
                {
                  backgroundColor:
                    inputText.trim() && !sendMutation.isPending
                      ? persona.colors.accent
                      : persona.colors.border,
                },
              ]}
              onPress={handleSend}
              disabled={!inputText.trim() || sendMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              {sendMutation.isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.sendArrow}>↑</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </PersonaBackground>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:  { flex: 1 },
  flex:  { flex: 1 },

  header: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
    paddingHorizontal: 20,
    paddingTop:        12,
    paddingBottom:     8,
  },
  wordmark: {
    fontSize:      20,
    fontWeight:    "700",
    letterSpacing: -0.3,
  },
  headerRight: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           10,
  },
  speakingDot: {
    width:          32,
    height:         32,
    alignItems:     "center",
    justifyContent: "center",
  },
  badge: {
    minWidth:       26,
    height:         26,
    borderRadius:   13,
    alignItems:     "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  badgeText: {
    color:      "#FFFFFF",
    fontSize:   13,
    fontWeight: "700",
  },

  proactivePanel: {
    paddingHorizontal: 16,
    paddingBottom:     4,
  },
  proactiveHeader: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
    marginBottom:   8,
  },
  proactiveTitle: {
    fontSize:      12,
    fontWeight:    "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  clearAll: {
    fontSize:   13,
    fontWeight: "500",
  },

  freddieCard: {
    marginHorizontal: 16,
    marginBottom:     8,
    padding:          12,
    borderRadius:     12,
    borderWidth:      1,
  },
  freddieLabel: {
    fontSize:      10,
    fontWeight:    "700",
    letterSpacing: 0.8,
    marginBottom:  4,
  },
  freddieText: {
    fontSize:   13,
    lineHeight: 18,
  },

  messageList: {
    paddingTop:    8,
    paddingBottom: 16,
  },
  emptyState: {
    flex:              1,
    justifyContent:    "center",
    alignItems:        "center",
    paddingHorizontal: 40,
  },
  emptyGreeting: {
    fontSize:      28,
    fontWeight:    "700",
    textAlign:     "center",
    marginBottom:  12,
    letterSpacing: -0.3,
    lineHeight:    36,
    color:         "#FFFFFF",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  emptyName: {
    fontSize:   17,
    textAlign:  "center",
    lineHeight: 24,
    color:      "rgba(255,255,255,0.7)",
  },
  errorText: {
    color:             "#C4622D",
    fontSize:          13,
    textAlign:         "center",
    paddingHorizontal: 20,
    paddingVertical:   6,
  },

  inputBar: {
    flexDirection:     "row",
    alignItems:        "flex-end",
    paddingHorizontal: 12,
    paddingTop:        10,
    paddingBottom:     Platform.OS === "ios" ? 10 : 28,
    borderTopWidth:    1,
    gap:               8,
  },
  textInput: {
    flex:        1,
    fontSize:    17,
    lineHeight:  24,
    maxHeight:   120,
    paddingTop:  8,
    paddingBottom: 8,
  },
  sendBtn: {
    width:          44,
    height:         44,
    borderRadius:   22,
    alignItems:     "center",
    justifyContent: "center",
    marginBottom:   2,
  },
  sendArrow: {
    color:      "#FFFFFF",
    fontSize:   20,
    fontWeight: "700",
  },
  typingRow: {
    flexDirection:  "row",
    alignItems:     "center",
    paddingHorizontal: 20,
    paddingVertical:   12,
    gap: 10,
  },
  typingText: {
    fontSize:   15,
    fontStyle:  "italic",
  },
});
