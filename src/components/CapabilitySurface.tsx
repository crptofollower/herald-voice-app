// src/components/CapabilitySurface.tsx
// Transient capability proof card — attribution + concise result + deep link.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface Props {
  providerLabel: string;
  periodTitle: string;
  forecastText: string;
  sourceLinkLabel?: string;
  onViewForecast: () => void;
  surfaceTint?: string;
  accent?: string;
}

export function CapabilitySurface({
  providerLabel,
  periodTitle,
  forecastText,
  sourceLinkLabel = 'View forecast →',
  onViewForecast,
  surfaceTint = 'rgba(31, 58, 84, 0.55)',
  accent = '#4dd4d6',
}: Props) {
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: surfaceTint,
          borderColor: `${accent}44`,
        },
      ]}
      accessibilityRole="summary"
    >
      <Text style={[styles.provider, { color: `${accent}cc` }]} allowFontScaling>
        {providerLabel}
      </Text>
      <Text style={styles.periodTitle} allowFontScaling>
        {periodTitle}
      </Text>
      <Text style={styles.forecastText} allowFontScaling numberOfLines={3}>
        {forecastText}
      </Text>
      <TouchableOpacity
        onPress={onViewForecast}
        accessibilityRole="link"
        accessibilityLabel={sourceLinkLabel.replace(/\s*→\s*$/, '')}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={[styles.link, { color: accent }]} allowFontScaling>
          {sourceLinkLabel}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 0,
  },
  provider: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  periodTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.92)',
    marginBottom: 4,
  },
  forecastText: {
    fontSize: 14,
    lineHeight: 20,
    color: 'rgba(255,255,255,0.78)',
    marginBottom: 8,
  },
  link: {
    fontSize: 14,
    fontWeight: '600',
  },
});
