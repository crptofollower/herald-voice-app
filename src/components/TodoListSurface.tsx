// TodoListSurface.tsx — situational to-do presentation.
// Renders authoritative open todos in reader/presentation order.
// Does not mutate lists. Not a transcript. No grocery ordinal contract.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { TodoVisualRow } from '../routing/todoVisualPresentation';

interface Props {
  rows: TodoVisualRow[];
}

export function TodoListSurface({ rows }: Props) {
  const count = rows.length;
  const countLabel = count === 1 ? '1 item' : `${count} items`;
  return (
    <View style={styles.surface} accessibilityRole="summary">
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.cue} allowFontScaling>
            {'\uD83D\uDCCB'}
          </Text>
          <Text style={styles.title} allowFontScaling>
            TO-DO
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
  body: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
    color: 'rgba(235, 240, 238, 0.88)',
  },
});
