// ProactiveCard.tsx -- Dismissable proactive notification card
// Build 21 fix: backend items use { text, type } not { title, body, type }.
//   TYPE_LABELS/COLORS now cover all backend type values including
//   morning_briefing, afternoon_checkin, medication_check, watcher_alert.
//   Unknown types fall back to a generic label instead of crashing.
//   item.title falls back to item.text so backend messages always render.

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

// All known backend type values — extend here as new types are added.
const TYPE_LABELS: Record<string, string> = {
  freddie:           "TRADE SETUP",
  weather:           "WEATHER",
  sports:            "SPORTS",
  health:            "HEALTH",
  reminder:          "REMINDER",
  news:              "NEWS",
  morning_briefing:  "MORNING",
  afternoon_checkin: "CHECK-IN",
  medication_check:  "MEDICATION",
  watcher_alert:     "ALERT",
};

const TYPE_COLORS: Record<string, string> = {
  freddie:           "#2A7BB5",
  weather:           "#5A7A3A",
  sports:            "#C4622D",
  health:            "#8B4A9E",
  reminder:          "#6B5F54",
  news:              "#1A1A1A",
  morning_briefing:  "#2A7BB5",
  afternoon_checkin: "#5A7A3A",
  medication_check:  "#8B4A9E",
  watcher_alert:     "#C4622D",
};

const FALLBACK_LABEL = "HERALD";
const FALLBACK_COLOR = "#4A5568";

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

  const typeLabel = TYPE_LABELS[item.type] ?? FALLBACK_LABEL;
  const typeColor = TYPE_COLORS[item.type] ?? FALLBACK_COLOR;

  // Backend sends { text } — ProactiveItem interface has { title, body }.
  // Support both shapes so old and new backend items render correctly.
  const displayTitle = item.title || (item as any).text || "";
  const displayBody  = item.body  || "";

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
        accessibilityLabel={`${typeLabel}: ${displayTitle}`}
      >
        <View style={styles.header}>
          <View style={[styles.typePill, { backgroundColor: typeColor + "18" }]}>
            <Text style={[styles.typeLabel, { color: typeColor }]}>
              {typeLabel}
            </Text>
          </View>

          <TouchableOpacity
            onPress={handleDismiss}
            style={styles.dismissBtn}
            hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
            accessibilityLabel="Dismiss"
          >
            <Text style={[styles.dismissX, { color: persona.colors.textMuted }]}>
              ×
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.title, { color: persona.colors.text }]}>
          {displayTitle}
        </Text>

        {displayBody ? (
          <Text style={[styles.body, { color: persona.colors.textMuted }]}>
            {displayBody}
          </Text>
        ) : null}
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
    fontSize: 18,
    lineHeight: 22,
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
