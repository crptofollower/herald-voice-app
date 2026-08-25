// src/components/CapabilitySurface.tsx
// Transient capability inset — attribution + concise result + understated source link.
// Secondary to Kit's spoken/text answer. Not a modal or provider-app card.

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
        styles.inset,
        {
          backgroundColor: surfaceTint,
          borderLeftColor: `${accent}99`,
        },
      ]}
      accessibilityRole="summary"
    >
      <Text style={[styles.provider, { color: `${accent}aa` }]} allowFontScaling>
        {providerLabel}
      </Text>
      <Text style={styles.periodTitle} allowFontScaling>
        {periodTitle}
      </Text>
      <Text style={styles.forecastText} allowFontScaling>
        {forecastText}
      </Text>
      <TouchableOpacity
        onPress={onViewForecast}
        style={styles.linkHit}
        accessibilityRole="link"
        accessibilityLabel={sourceLinkLabel.replace(/\s*→\s*$/, '')}
      >
        <Text style={[styles.link, { color: accent }]} allowFontScaling>
          {sourceLinkLabel}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
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
  provider: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 2,
  },
  periodTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.88)',
    marginBottom: 2,
  },
  forecastText: {
    fontSize: 14,
    lineHeight: 20,
    color: 'rgba(255,255,255,0.78)',
    marginBottom: 4,
  },
  linkHit: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  link: {
    fontSize: 14,
    fontWeight: '500',
  },
});
