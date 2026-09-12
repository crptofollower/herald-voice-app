// GroceryListSurface.tsx — compatibility wrapper. Stage 1 grocery UI lives
// in GrocerySurface.

import React from 'react';
import { GrocerySurface } from './GrocerySurface';
import type { GroceryVisualRow } from '../routing/groceryVisualPresentation';

interface Props {
  rows: GroceryVisualRow[];
}

export function GroceryListSurface({ rows }: Props) {
  return (
    <GrocerySurface
      rows={rows.map((row) => ({ id: row.id, body: row.body, status: 'open' as const }))}
      remainingCount={rows.length}
      surfaceTint="rgba(31, 58, 84, 0.55)"
      accent="#4dd4d6"
    />
  );
}
