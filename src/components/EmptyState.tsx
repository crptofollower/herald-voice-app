// src/components/EmptyState.tsx -- Contextual empty state + skeleton placeholders
//
// FIXES APPLIED (May 12 2026):
//
//   The original file imported from three modules that do not exist:
//     · ../tokens/theme  (useTheme, SPACING, RADIUS, FONT_SIZE, FONT_WEIGHT)
//     · ./Button
//     · ./Typography     (Heading, Body)
//   These were aspirational design-system stubs — they were written assuming
//   a token library that hasn't been built yet. The app failed to start because
//   Metro's module resolver threw on all three imports.
//
//   Fix: replaced every external import with self-contained inline constants
//   and standard React Native primitives. All exported types and component
//   signatures are preserved exactly so callers don't need to change.
//
//   Also fixed: SkeletonBox started the Animated.loop but never stopped it
//   on unmount, leaking the animation loop. Added cleanup return to useEffect.
//
// TODO (design system phase):
//   Once ../tokens/theme and ./Button and ./Typography are real modules,
//   swap the inline SPACING / RADIUS constants and ActionButton back to them.
//   The exported interface is already shaped to accept those variants.

import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  Animated,
  StyleSheet,
  TouchableOpacity,
  type StyleProp,
  type ViewStyle,
} from "react-native";

// ─── Inline design tokens ─────────────────────────────────────────────────────
// These mirror the values ../tokens/theme would have exported.
// Centralise into a real tokens file once the design system is established.

const SPACING = {
  xs:   4,
  sm:   8,
  md:   12,
  lg:   16,
  xl:   20,
  xxl:  24,
  xxxl: 32,
  huge: 48,
} as const;

const RADIUS = {
  sm: 4,
  md: 8,
  lg: 12,
} as const;

// Neutral skeleton shimmer color. Works well on the beach/desert/country
// persona backgrounds. Replace with a theme-aware value when dark mode is wired.
const SKELETON_COLOR = "#E5E5EA";

// ─────────────────────────────────────────────────────────────────────────────
// EmptyState
// ─────────────────────────────────────────────────────────────────────────────

interface EmptyStateAction {
  label:    string;
  onPress:  () => void;
  variant?: "primary" | "secondary" | "ghost";
}

export interface EmptyStateProps {
  /** Large emoji or symbol (rendered as text). */
  icon?: string;
  title: string;
  description?: string;
  /** Primary call-to-action. */
  action?: EmptyStateAction;
  /** Secondary CTA (e.g. "Learn more"). */
  secondaryAction?: EmptyStateAction;
  style?: StyleProp<ViewStyle>;
  /** "center" (default) for full-screen states; "top" for list empty states. */
  align?: "center" | "top";
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  style,
  align = "center",
}: EmptyStateProps) {
  return (
    <View
      style={[
        styles.container,
        align === "top" && styles.containerTop,
        style,
      ]}
      accessibilityRole="text"
    >
      {icon && (
        <Text style={styles.icon} accessibilityElementsHidden>
          {icon}
        </Text>
      )}

      <Text style={styles.title}>{title}</Text>

      {description && (
        <Text style={styles.description}>{description}</Text>
      )}

      {(action || secondaryAction) && (
        <View style={styles.actions}>
          {action && <ActionButton action={action} />}
          {secondaryAction && <ActionButton action={secondaryAction} ghost />}
        </View>
      )}
    </View>
  );
}

// ─── ActionButton ─────────────────────────────────────────────────────────────
// Replaces the missing ./Button component with an equivalent TouchableOpacity.
// Supports the same variant strings so the interface is forward-compatible.

interface ActionButtonProps {
  action: EmptyStateAction;
  /** Forces ghost style regardless of action.variant. */
  ghost?: boolean;
}

function ActionButton({ action, ghost = false }: ActionButtonProps) {
  const isGhost = ghost || action.variant === "ghost";
  return (
    <TouchableOpacity
      onPress={action.onPress}
      style={[styles.btn, isGhost && styles.btnGhost]}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={action.label}
    >
      <Text style={[styles.btnText, isGhost && styles.btnTextGhost]}>
        {action.label}
      </Text>
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SkeletonBox — shimmer building block
// ─────────────────────────────────────────────────────────────────────────────

interface SkeletonBoxProps {
  width:  number | `${number}%`;
  height: number;
  style?: StyleProp<ViewStyle>;
}

function SkeletonBox({ width, height, style }: SkeletonBoxProps) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // FIX: the original code called loop.start() but had no cleanup.
    // Unmounting the component while the animation was running leaked the
    // Animated loop, keeping the JS thread timer alive indefinitely.
    // Fix: store the loop handle and call stop() in the cleanup function.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, {
          toValue:         1,
          duration:        900,
          useNativeDriver: true,
        }),
        Animated.timing(shimmer, {
          toValue:         0,
          duration:        900,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop(); // ← cleanup (was missing in original)
  }, [shimmer]);

  const opacity = shimmer.interpolate({
    inputRange:  [0, 1],
    outputRange: [0.4, 0.9],
  });

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius:    RADIUS.md,
          backgroundColor: SKELETON_COLOR,
          opacity,
        },
        style,
      ]}
      accessibilityElementsHidden
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SkeletonMessage — one fake message bubble
// ─────────────────────────────────────────────────────────────────────────────

interface SkeletonMessageProps {
  isUser:     boolean;
  lineCount?: 1 | 2 | 3;
  /** Approximate width of the widest line as a percentage of the bubble. */
  widthPct?:  number;
}

export function SkeletonMessage({
  isUser,
  lineCount = 2,
  widthPct  = 65,
}: SkeletonMessageProps) {
  return (
    <View
      style={[
        skStyles.container,
        isUser ? skStyles.userSide : skStyles.heraldSide,
      ]}
    >
      <View style={skStyles.bubble}>
        {Array.from({ length: lineCount }).map((_, i) => (
          <SkeletonBox
            key={i}
            // Last line is shorter to mimic natural sentence endings.
            width={`${i === lineCount - 1 ? Math.round(widthPct * 0.7) : widthPct}%` as `${number}%`}
            height={14}
            style={i > 0 ? { marginTop: SPACING.xs } : undefined}
          />
        ))}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SkeletonMessageList — realistic 3-bubble placeholder for the message list
// ─────────────────────────────────────────────────────────────────────────────

export function SkeletonMessageList() {
  return (
    <View style={skStyles.list} accessibilityLabel="Loading messages">
      <SkeletonMessage isUser={false} lineCount={2} widthPct={72} />
      <SkeletonMessage isUser={true}  lineCount={1} widthPct={55} />
      <SkeletonMessage isUser={false} lineCount={3} widthPct={80} />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex:              1,
    alignItems:        "center",
    justifyContent:    "center",
    paddingHorizontal: SPACING.xxxl,
    paddingVertical:   SPACING.huge,
  },
  containerTop: {
    justifyContent: "flex-start",
    paddingTop:     SPACING.xxxl,
  },
  icon: {
    fontSize:     48,
    marginBottom: SPACING.xl,
    textAlign:    "center",
  },
  title: {
    fontSize:      26,
    fontWeight:    "700",
    color:         "#1A1714",
    textAlign:     "center",
    marginBottom:  SPACING.md,
    letterSpacing: -0.5,
    lineHeight:    34,
  },
  description: {
    fontSize:     16,
    color:        "#6B5F54",
    textAlign:    "center",
    lineHeight:   24,
    marginBottom: SPACING.xxl,
  },
  actions: {
    gap:        SPACING.sm,
    alignItems: "center",
  },

  // ActionButton styles — forward-compatible with ./Button's primary/ghost API
  btn: {
    backgroundColor:   "#2A7BB5",
    paddingVertical:   12,
    paddingHorizontal: 24,
    borderRadius:      RADIUS.lg,
    alignItems:        "center",
    minWidth:          140,
  },
  btnGhost: {
    backgroundColor: "transparent",
    borderWidth:     1,
    borderColor:     "#E8DDD2",
  },
  btnText: {
    color:      "#FFFFFF",
    fontSize:   15,
    fontWeight: "600",
  },
  btnTextGhost: {
    color: "#6B5F54",
  },
});

const skStyles = StyleSheet.create({
  list: {
    paddingTop:    SPACING.md,
    paddingBottom: SPACING.lg,
  },
  container: {
    marginVertical:    SPACING.xs,
    paddingHorizontal: SPACING.lg,
  },
  userSide:   { alignItems: "flex-end" },
  heraldSide: { alignItems: "flex-start" },
  bubble: {
    maxWidth:          "82%",
    paddingHorizontal: SPACING.lg,
    paddingVertical:   SPACING.md,
  },
});
