// Schedule capability surface — agenda projection of presented calendar
// cache rows. Not a list-completion control. Provenance is evidence-only.

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CapabilitySurfaceFrame } from './CapabilitySurfaceFrame';
import type { ScheduleScope, ScheduleSurfaceRow } from '../routing/scheduleSurfacePresentation';
import { scheduleScopeLabel } from '../routing/scheduleSurfacePresentation';

const ICON_GLYPH: Record<ScheduleSurfaceRow['icon'], string> = {
  flight: '\u2708\uFE0F',
  birthday: '\uD83C\uDF82',
  dining: '\uD83C\uDF74',
  doctor: '\uD83E\uDE7A',
  generic: '\uD83D\uDCC5',
};

type Props = {
  rows: ScheduleSurfaceRow[];
  scope: ScheduleScope;
  cacheUnloaded: boolean;
  surfaceTint: string;
  accent: string;
};

function formatTime(row: ScheduleSurfaceRow): string {
  if (row.allDay) return 'All day';
  return new Date(row.startMs).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function weekdayShort(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: 'short' }).toUpperCase();
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function groupRows(rows: ScheduleSurfaceRow[], scope: ScheduleScope): { heading: string | null; rows: ScheduleSurfaceRow[] }[] {
  if (scope === 'today' || scope === 'tomorrow' || scope === 'yesterday') {
    return [{ heading: null, rows }];
  }
  const groups: { heading: string | null; rows: ScheduleSurfaceRow[] }[] = [];
  let current: { heading: string | null; rows: ScheduleSurfaceRow[] } | null = null;
  for (const row of rows) {
    const heading = scope === 'last month'
      ? new Date(row.startMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
      : weekdayShort(row.startMs);
    if (!current || current.heading !== heading) {
      current = { heading, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

export function ScheduleSurface({
  rows,
  scope,
  cacheUnloaded,
  surfaceTint,
  accent,
}: Props) {
  const groups = groupRows(rows, scope);
  const showDayOnRow = scope === 'today' || scope === 'tomorrow' || scope === 'yesterday';
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
        identityCue={'\uD83D\uDCC5'}
        title="SCHEDULE"
        countLabel="From your calendar"
        accessibilityLabel={`Schedule, ${scheduleScopeLabel(scope).toLowerCase()}, from your calendar`}
      >
        <Text style={styles.scope} allowFontScaling>
          {scheduleScopeLabel(scope)}
        </Text>
        {cacheUnloaded ? (
          <Text style={styles.empty} allowFontScaling>
            I don't have your calendar loaded yet. Connect once with calendar access granted, then try again offline.
          </Text>
        ) : (
          groups.map((group) => (
            <View key={group.heading ?? 'flat'}>
              {group.heading ? (
                <Text style={styles.dayHead} allowFontScaling>
                  {group.heading}
                </Text>
              ) : null}
              {group.rows.map((row, index) => (
                <View
                  key={row.id}
                  style={[
                    styles.row,
                    index < group.rows.length - 1 ? styles.divider : null,
                  ]}
                  accessibilityState={{ disabled: true }}
                >
                  <Text style={styles.icon} allowFontScaling>
                    {ICON_GLYPH[row.icon]}
                  </Text>
                  <View style={styles.body}>
                    <Text style={styles.when} allowFontScaling>
                      {showDayOnRow
                        ? `${weekdayShort(row.startMs)} \u00B7 ${formatTime(row)}`
                        : formatTime(row)}
                    </Text>
                    <Text style={styles.title} allowFontScaling>
                      {row.title}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ))
        )}
      </CapabilitySurfaceFrame>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: 8, flexGrow: 1 },
  scope: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.0,
    color: 'rgba(200, 220, 230, 0.72)',
    marginBottom: 5,
  },
  empty: {
    fontSize: 15,
    lineHeight: 20,
    color: 'rgba(248, 250, 249, 0.62)',
    paddingVertical: 8,
  },
  dayHead: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.0,
    color: 'rgba(200, 220, 230, 0.55)',
    marginTop: 5,
    marginBottom: 2,
  },
  row: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 6,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  icon: {
    fontSize: 16,
    lineHeight: 18,
    marginRight: 8,
    marginTop: 1,
  },
  body: { flex: 1, minWidth: 0 },
  when: {
    fontSize: 12,
    lineHeight: 16,
    color: 'rgba(248, 250, 249, 0.58)',
    marginBottom: 1,
  },
  title: {
    fontSize: 16,
    lineHeight: 18,
    fontWeight: '500',
    color: 'rgba(248, 250, 249, 0.94)',
  },
});
