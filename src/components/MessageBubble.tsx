// MessageBubble.tsx -- Chat message display
// User bubbles: persona accent. Herald bubbles: surface.
// Large text, generous padding -- optimized for 65+ readability.

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { Message } from "../api/herald";
import type { Persona } from "../constants/personas";

interface Props {
  message: Message;
  persona: Persona;
}

export function MessageBubble({ message, persona }: Props) {
  const isUser = message.role === "user";

  return (
    <View
      style={[
        styles.container,
        isUser ? styles.userContainer : styles.heraldContainer,
      ]}
    >
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: isUser
              ? persona.colors.userBubble
              : persona.colors.heraldBubble,
            borderColor: isUser ? "transparent" : persona.colors.border,
          },
        ]}
      >
        <Text
          style={[
            styles.text,
            {
              color: isUser
                ? persona.colors.textInverse
                : persona.colors.text,
            },
          ]}
          selectable
        >
          {message.content}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 4,
    paddingHorizontal: 16,
  },
  userContainer: {
    alignItems: "flex-end",
  },
  heraldContainer: {
    alignItems: "flex-start",
  },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
    borderWidth: 1,
  },
  text: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "400",
  },
});
