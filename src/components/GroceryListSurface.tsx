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
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.cue} allowFontScaling>
            {'\uD83D\uDED2'}
          </Text>
          <Text style={styles.title} allowFontScaling>
            GROCERY LIST
          </Text>
        </View>
        <Text style={styles.count} allowFontScaling>
          {countLabel}
        </Text>
      </View>
      {rows.map((row, index) => (
        <View
          key={row.id}
          style={[styles.row, index < rows.length - 1 ? styles.rowDivider : null]}
        >
          <View style={styles.badge}>
            <Text style={styles.number} allowFontScaling numberOfLines={1}>
              {row.position}
            </Text>
          </View>
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
    paddingTop: 12,
    paddingBottom: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(12, 28, 22, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(110, 210, 160, 0.22)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
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
    color: 'rgba(200, 230, 214, 0.88)',
  },
  count: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
    marginLeft: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  badge: {
    minWidth: 28,
    paddingHorizontal: 4,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'flex-start',
    flexShrink: 0,
  },
  number: {
    minWidth: 20,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    textAlign: 'center',
    color: 'rgba(150, 210, 180, 0.92)',
  },
  body: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
    color: 'rgba(235, 240, 238, 0.88)',
  },
});
