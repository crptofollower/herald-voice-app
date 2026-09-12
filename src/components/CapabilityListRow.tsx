// Shared list row chrome for capability surfaces. Presentation only.

import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';

type Props = {
  body: string;
  status: 'open' | 'completed';
  showDivider: boolean;
  onPressOpen?: () => void;
};

export function CapabilityListRow({ body, status, showDivider, onPressOpen }: Props) {
  const completed = status === 'completed';
  const rowStyle = [styles.row, showDivider ? styles.divider : null];
  const bodyEl = (
    <Text
      style={[styles.body, completed ? styles.bodyCompleted : null]}
      allowFontScaling
    >
      {body}
    </Text>
  );

  if (completed || !onPressOpen) {
    return (
      <View style={rowStyle} accessibilityState={{ disabled: true }}>
        {bodyEl}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPressOpen}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={body}
    >
      {bodyEl}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  body: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '500',
    color: 'rgba(248, 250, 249, 0.94)',
  },
  bodyCompleted: {
    color: 'rgba(248, 250, 249, 0.42)',
    textDecorationLine: 'line-through',
  },
});
