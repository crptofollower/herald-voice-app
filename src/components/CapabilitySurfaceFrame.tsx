// Shared capability-surface chrome. Behavior-agnostic: list and inset
// variants only. Does not own domain truth or writers.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export function deriveQuieterListSurfaceTint(personaTint: string): string {
  const m = personaTint.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/);
  if (!m) return 'rgba(18, 22, 26, 0.40)';
  const alpha = Math.min(Number(m[4]) * 0.55, 0.36);
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}

type Props = {
  variant: 'list' | 'inset';
  surfaceTint: string;
  accent?: string;
  identityCue?: string;
  title?: string;
  countLabel?: string;
  children: React.ReactNode;
  accessibilityLabel?: string;
};

export function CapabilitySurfaceFrame({
  variant,
  surfaceTint,
  accent = '#4dd4d6',
  identityCue,
  title,
  countLabel,
  children,
  accessibilityLabel,
}: Props) {
  const tint = variant === 'list' ? deriveQuieterListSurfaceTint(surfaceTint) : surfaceTint;
  const borderColor = variant === 'list'
    ? 'rgba(255,255,255,0.10)'
    : `${accent}99`;

  return (
    <View
      style={[
        variant === 'list' ? styles.list : styles.inset,
        {
          backgroundColor: tint,
          borderColor: variant === 'list' ? borderColor : undefined,
          borderLeftColor: variant === 'inset' ? borderColor : undefined,
        },
      ]}
      accessibilityRole="summary"
      accessibilityLabel={accessibilityLabel}
    >
      {title ? (
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {identityCue ? (
              <Text style={styles.cue} allowFontScaling>
                {identityCue}
              </Text>
            ) : null}
            <Text style={[styles.title, { color: `${accent}cc` }]} allowFontScaling>
              {title}
            </Text>
          </View>
          {countLabel ? (
            <Text style={styles.count} allowFontScaling>
              {countLabel}
            </Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  inset: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    borderLeftWidth: 2,
    minWidth: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.10)',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  cue: {
    fontSize: 16,
    lineHeight: 20,
    marginRight: 6,
  },
  title: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  count: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
    marginLeft: 8,
  },
});
