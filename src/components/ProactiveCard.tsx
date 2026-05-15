// ProactiveCard.tsx -- Dismissable proactive notification card
// Handles Freddie trade setups, weather alerts, sports, and general items.
// Accessible: large touch targets, high contrast, readable text.

import React, { useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from "react-native";
import type { ProactiveItem } from "../api/herald";
import type { Persona } from "../constants/personas";

const TYPE_LABELS: Record<ProactiveItem["type"], string> = {
  freddie: "TRADE SETUP",
  weather: "WEATHER",
  sports: "SPORTS",
  health: "HEALTH",
  reminder: "REMINDER",
  news: "NEWS",
};

const TYPE_COLORS: Record<ProactiveItem["type"], string> = {
  freddie: "#2A7BB5",
  weather: "#5A7A3A",
  sports: "#C4622D",
  health: "#8B4A9E",
  reminder: "#6B5F54",
  news: "#1A1A1A",
};

interface Props {
  item: ProactiveItem;
  persona: Persona;
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
}

export function ProactiveCard({ item, persona, onRead, onDismiss }: Props) {
  const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  const handleDismiss = () => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: -10,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => onDismiss(item.id));
  };

  const handlePress = () => {
    onRead(item.id);
  };

  const typeColor = TYPE_COLORS[item.type];

  return (
    <Animated.View
      style={[
        styles.card,
        {
          backgroundColor: persona.colors.proactiveCard,
          borderColor: persona.colors.border,
          opacity,
          transform: [{ translateY }],
        },
      ]}
    >
      <TouchableOpacity
        style={styles.pressable}
        onPress={handlePress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={`${TYPE_LABELS[item.type]}: ${item.title}`}
      >
        <View style={styles.header}>
          <View style={[styles.typePill, { backgroundColor: typeColor + "18" }]}>
            <Text style={[styles.typeLabel, { color: typeColor }]}>
              {TYPE_LABELS[item.type]}
            </Text>
          </View>

          <TouchableOpacity
            onPress={handleDismiss}
            style={styles.dismissBtn}
            hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
            accessibilityLabel="Dismiss"
          >
            <Text style={[styles.dismissX, { color: persona.colors.textMuted }]}>
              x
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.title, { color: persona.colors.text }]}>
          {item.title}
        </Text>

        <Text style={[styles.body, { color: persona.colors.textMuted }]}>
          {item.body}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 10,
    overflow: "hidden",
  },
  pressable: {
    padding: 16,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  typePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  typeLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  dismissBtn: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  dismissX: {
    fontSize: 16,
    lineHeight: 20,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
    lineHeight: 22,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
});
