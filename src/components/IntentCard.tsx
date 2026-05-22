// src/components/IntentCard.tsx
// Herald action confirmation card.
// Appears after Herald detects an intent (calendar, maps, SMS, flights, etc.)
// Herald OFFERS the action here. User confirms. App executes.
// This is what prevents Herald from hallucinating "Done!" on things it can't do.

import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";

interface IntentAction {
  type: string;
  value: string;
}

export type ActionStatus = "confirming" | "executing" | "done" | "error";

interface PersonaTheme {
  colors: {
    accent: string;
    text: string;
    textMuted: string;
    border: string;
    accentMuted: string;
  };
}

interface IntentCardProps {
  action: IntentAction;
  status: ActionStatus;
  persona: PersonaTheme;
  onConfirm: () => void;
  onDismiss: () => void;
}

// ─── Action label builder ─────────────────────────────────────────────────────
// Translates raw action data into human-readable copy.
// Every action type must have an entry here.

function getActionLabel(action: IntentAction): {
  icon: string;
  title: string;
  confirm: string;
} {
  const { type, value } = action;
  const parts = value.split("|").map((s) => s.trim());

  switch (type) {
    case "maps":
      return {
        icon: "📍",
        title: `Open map for ${value}?`,
        confirm: "Open Map",
      };

    case "calendar": {
      const title = parts[0] || "Appointment";
      const dateStr = parts[1] || "";
      const timeStr = parts[2] || "";
      const datePart = dateStr ? ` on ${formatDate(dateStr)}` : "";
      const timePart = timeStr ? ` at ${formatTime(timeStr)}` : "";
      return {
        icon: "📅",
        title: `Add "${title}" to your calendar${datePart}${timePart}?`,
        confirm: "Yes, Add It",
      };
    }

    case "sms": {
      const contact = parts[0] || "them";
      const msg = parts[1] || "";
      const preview = msg.length > 35 ? msg.substring(0, 35) + "…" : msg;
      return {
        icon: "💬",
        title: `Open messages to text ${contact}${preview ? `: "${preview}"` : ""}?`,
        confirm: "Open Messages",
      };
    }

    case "phone":
      return {
        icon: "📞",
        title: `Call ${value}?`,
        confirm: "Call Now",
      };

    case "flights": {
      const preview = value.length > 50 ? value.substring(0, 50) + "…" : value;
      return {
        icon: "✈️",
        title: `Search Google Flights for ${preview}?`,
        confirm: "Search Flights",
      };
    }

    case "search": {
      const preview = value.length > 50 ? value.substring(0, 50) + "…" : value;
      return {
        icon: "🔍",
        title: `Search for "${preview}"?`,
        confirm: "Open Search",
      };
    }

    case "launch":
      return {
        icon: "📱",
        title: `Open ${value}?`,
        confirm: "Open App",
      };

    case "music":
      return {
        icon: "🎵",
        title: `Play "${value}" on Spotify?`,
        confirm: "Play Music",
      };

    case "radio":
      return {
        icon: "📻",
        title: `Open ${value}?`,
        confirm: "Open Radio",
      };

    default:
      return {
        icon: "▶️",
        title: "Want me to do that?",
        confirm: "Yes",
      };
  }
}

// ─── Date/time formatters ─────────────────────────────────────────────────────

function formatTime(time: string): string {
  try {
    const [hStr, mStr] = time.split(":");
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr || "0", 10);
    const ampm = h >= 12 ? "pm" : "am";
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
  } catch {
    return time;
  }
}

function formatDate(date: string): string {
  try {
    // Add noon to avoid timezone date-shift issues
    const d = new Date(`${date}T12:00:00`);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  } catch {
    return date;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function IntentCard({
  action,
  status,
  persona,
  onConfirm,
  onDismiss,
}: IntentCardProps) {
  const { icon, title, confirm } = getActionLabel(action);

  const isExecuting = status === "executing";
  const isDone = status === "done";
  const isError = status === "error";
  const showButtons = !isDone && !isError;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: "rgba(0,0,0,0.82)",
          borderColor: persona.colors.accent + "35",
          borderTopColor: persona.colors.accent,
        },
      ]}
    >
      <View style={styles.top}>
        <Text style={styles.icon}>{isDone ? "✅" : isError ? "⚠️" : icon}</Text>
        <Text style={[styles.title, { color: "#FFFFFF" }]}>
          {isDone
            ? "Done."
            : isError
            ? "Something went wrong — try again."
            : title}
        </Text>
      </View>

      {showButtons && (
        <View style={styles.buttons}>
          <TouchableOpacity
            style={[
              styles.confirmBtn,
              { backgroundColor: persona.colors.accent },
              isExecuting && styles.btnDisabled,
            ]}
            onPress={onConfirm}
            disabled={isExecuting}
            accessibilityRole="button"
            accessibilityLabel={confirm}
          >
            {isExecuting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.confirmText}>{confirm}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.dismissBtn}
            onPress={onDismiss}
            disabled={isExecuting}
            accessibilityRole="button"
            accessibilityLabel="No thanks"
          >
            <Text style={[styles.dismissText, { color: "rgba(255,255,255,0.55)" }]}>
              No thanks
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderTopWidth: 2,
    gap: 12,
  },
  top: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  icon: {
    fontSize: 20,
    lineHeight: 26,
  },
  title: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "500",
  },
  buttons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingLeft: 30, // align with text, past the icon
  },
  confirmBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 110,
    minHeight: 40,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  confirmText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  dismissBtn: {
    paddingVertical: 10,
  },
  dismissText: {
    fontSize: 14,
    fontWeight: "400",
  },
});
