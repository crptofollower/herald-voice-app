// Typed world-context need. Routing sets it. Transport only applies it.

export type WorldContextNeed = {
  time: 'none' | 'local_clock' | 'local_date';
  location: 'none' | 'precise';
};

export const NO_WORLD_CONTEXT: WorldContextNeed = { time: 'none', location: 'none' };

/** Existing live-data signal order in tierRouter. Index is the matched signal, not prose. */
const LIVE_SIGNAL_NEED: readonly WorldContextNeed[] = [
  { time: 'local_date', location: 'precise' },
  NO_WORLD_CONTEXT,
  NO_WORLD_CONTEXT,
  NO_WORLD_CONTEXT,
  NO_WORLD_CONTEXT,
  { time: 'none', location: 'precise' },
  { time: 'none', location: 'precise' },
  { time: 'none', location: 'precise' },
  NO_WORLD_CONTEXT,
  NO_WORLD_CONTEXT,
];

export function worldContextForLiveSignal(index: number): WorldContextNeed {
  return LIVE_SIGNAL_NEED[index] ?? NO_WORLD_CONTEXT;
}

export function applyWorldContext(
  need: WorldContextNeed,
  available: { localTime?: string; localDate?: string; lat?: number; lng?: number; locationLabel?: string },
): { local_time?: string; local_date?: string; lat?: number; lng?: number; location_label?: string } {
  const out: { local_time?: string; local_date?: string; lat?: number; lng?: number; location_label?: string } = {};
  if (need.time === 'local_clock') out.local_time = available.localTime;
  if (need.time === 'local_date') out.local_date = available.localDate;
  if (need.location === 'precise') {
    out.lat = available.lat;
    out.lng = available.lng;
    out.location_label = available.locationLabel;
  }
  return out;
}
