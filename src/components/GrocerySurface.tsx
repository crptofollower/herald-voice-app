// Grocery capability surface — projection of committed open rows plus a
// RAM completed-visible overlay. Overlay is never write authority.

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { CapabilitySurfaceFrame } from './CapabilitySurfaceFrame';
import { CapabilityListRow } from './CapabilityListRow';
import type { GroceryMergedRow } from '../routing/grocerySurfacePresentation';

type Props = {
  rows: GroceryMergedRow[];
  remainingCount: number;
  surfaceTint: string;
  accent: string;
  onCompleteOpenRow?: (id: string) => void;
};

export function GrocerySurface({
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
        identityCue={'\uD83D\uDED2'}
        title="GROCERY"
        countLabel={countLabel}
        accessibilityLabel={`Grocery list, ${countLabel}`}
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
