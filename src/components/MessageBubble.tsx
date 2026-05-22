// MessageBubble.tsx -- Chat message display
// Updated May 17 2026 -- VOICE-FIRST FLOATING DESIGN
//
// DESIGN CHANGE (the "should it float?" question -- answer: yes):
//
//   Herald is ONE entity speaking TO you, not a two-party text thread.
//   The chat-bubble metaphor fought that. Removed it for Herald.
//
//   Herald's response now:
//     - No hard-edged box. No rounded prison. The words float.
//     - A soft vertical gradient scrim sits behind the text so it stays
//       readable over the scene photo (mandatory for 65+ eyes -- you cannot
//       float white text on a bright sky). The scrim is edge-soft, not a tile.
//     - Large type (20px), generous line height -- presented, not posted.
//     - Gentle fade + rise on mount: it feels spoken into being.
//
//   User's message stays a small muted chip, right-aligned. It is a receipt
//   of what Herald heard -- it should not compete with Herald's voice.
//
//   This mirrors how Google Assistant / Siri / ChatGPT voice present answers:
//   the response IS the screen, not a message in a list.
//
//   expo-linear-gradient is used for the scrim (already an Expo SDK module;
//   if the import fails, swap LinearGradient for a plain View with
//   backgroundColor: "rgba(0,0,0,0.5)" -- noted inline).

import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import type { Message } from "../api/herald";
import type { Persona } from "../constants/personas";

interface Props {
  message: Message;
  persona: Persona;
}

export function MessageBubble({ message, persona }: Props) {
  const isUser = message.role === "user";

  // Fade + rise in. Herald's words "arrive" rather than "post".
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 260,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  // ── User: small muted chip (a receipt of what was heard) ──────────────────
  if (isUser) {
    return (
      <Animated.View
        style={[
          styles.userRow,
          { opacity, transform: [{ translateY }] },
        ]}
      >
        <View
          style={[
            styles.userChip,
            { backgroundColor: persona.colors.userBubble },
          ]}
        >
          <Text style={styles.userText} selectable>
            {message.content}
          </Text>
        </View>
      </Animated.View>
    );
  }

  // ── Herald: floating words on a soft scrim (no box) ───────────────────────
  return (
    <Animated.View
      style={[
        styles.heraldRow,
        { opacity, transform: [{ translateY }] },
      ]}
    >
      {/* Soft scrim for legibility over the scene photo.
          If expo-linear-gradient is unavailable, replace this
          LinearGradient with:
            <View style={[styles.heraldScrim, { backgroundColor: "rgba(0,0,0,0.5)" }]}> */}
      <LinearGradient
        colors={[
          "rgba(0,0,0,0.0)",
          "rgba(0,0,0,0.42)",
          "rgba(0,0,0,0.42)",
          "rgba(0,0,0,0.0)",
        ]}
        locations={[0, 0.12, 0.88, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.heraldScrim}
      >
        <Text style={styles.heraldText} selectable>
          {message.content}
        </Text>
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // ── User chip ───────────────────────────────────────────────────────────
  userRow: {
    alignItems: "flex-end",
    paddingHorizontal: 16,
    marginVertical: 6,
  },
  userChip: {
    maxWidth: "78%",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    opacity: 0.92,
  },
  userText: {
    color: "#FFFFFF",
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "500",
  },

  // ── Herald floating response ────────────────────────────────────────────
  heraldRow: {
    paddingHorizontal: 6,
    marginVertical: 10,
  },
  heraldScrim: {
    // Edge-to-edge soft band, not a tile. Text floats; scrim only
    // exists so it reads over a bright background photo.
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderRadius: 8,
  },
  heraldText: {
    color: "#FFFFFF",
    fontSize: 20,
    lineHeight: 30,
    fontWeight: "400",
    // Subtle shadow doubles the legibility insurance over the scrim.
    textShadowColor: "rgba(0,0,0,0.55)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
});
