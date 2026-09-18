// To-do capability surface — projection of committed open todos plus a
// RAM completed-visible overlay. Overlay is never write authority.
// Open-row tap is exact-ID completion; voice confirmation remains separate.

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { CapabilitySurfaceFrame } from './CapabilitySurfaceFrame';
import { CapabilityListRow } from './CapabilityListRow';
import type { TodoMergedRow } from '../routing/todoSurfacePresentation';

type Props = {
  rows: TodoMergedRow[];
  remainingCount: number;
  surfaceTint: string;
  accent: string;
  onCompleteOpenRow?: (id: string) => void;
};

export function TodoSurface({
  rows,
  remainingCount,
  surfaceTint,
  accent,
  onCompleteOpenRow,
}: Props) {
  const countLabel = remainingCount === 1 ? '1 remaining' : `${remainingCount} remaining`;
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
    >
      <CapabilitySurfaceFrame
        variant="list"
        surfaceTint={surfaceTint}
        accent={accent}
        identityCue={'\uD83D\uDCCB'}
        title="TO-DO"
        countLabel={countLabel}
        accessibilityLabel={`To-do list, ${countLabel}`}
      >
        {rows.map((row, index) => (
          <CapabilityListRow
            key={row.id}
            body={row.body}
            status={row.status}
            showDivider={index < rows.length - 1}
            onPressOpen={
              row.status === 'open' && onCompleteOpenRow
                ? () => onCompleteOpenRow(row.id)
                : undefined
            }
          />
        ))}
      </CapabilitySurfaceFrame>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: 8, flexGrow: 1 },
});
