// GroceryListSurface.tsx — situational grocery presentation.
// Renders authoritative open items in the same order as Ordered Presentation.
// Does not mutate lists. Not a transcript.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { GroceryVisualRow } from '../routing/groceryVisualPresentation';

interface Props {
  rows: GroceryVisualRow[];
}

export function GroceryListSurface({ rows }: Props) {
  const count = rows.length;
  const countLabel = count === 1 ? '1 item' : `${count} items`;
  return (
    <View style={styles.surface} accessibilityRole="summary">
      <Text style={styles.cue} allowFontScaling>
        GROCERY
      </Text>
      <Text style={styles.title} allowFontScaling>
        GROCERY LIST
      </Text>
      <Text style={styles.count} allowFontScaling>
        {countLabel}
      </Text>
      {rows.map((row) => (
        <View key={row.id} style={styles.row}>
          <Text style={styles.number} allowFontScaling>
            {row.position}
          </Text>
          <Text style={styles.body} allowFontScaling>
            {row.body}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(12, 28, 22, 0.62)',
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(110, 210, 160, 0.85)',
  },
  cue: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: 'rgba(110, 210, 160, 0.9)',
    marginBottom: 2,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.94)',
    marginBottom: 4,
  },
  count: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.72)',
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 6,
  },
  number: {
    width: 36,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.92)',
  },
  body: {
    flex: 1,
    fontSize: 24,
    lineHeight: 34,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.94)',
  },
});
