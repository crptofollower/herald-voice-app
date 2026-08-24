// src/capabilities/nwsWeather.ts
// Bounded NWS Capability Surface — official api.weather.gov only.
// Pure functions: no React, SQLite, routing, or caching.

const NWS_BASE = 'https://api.weather.gov';
const NWS_USER_AGENT = 'Herald/1.0 (herald-app; contact@herald.app)';
const NWS_TIMEOUT_MS = 10_000;

export type NwsForecastResult = {
  providerLabel: string;
  periodTitle: string;
  forecastText: string;
  sourceUrl: string;
  sourceLinkLabel: string;
};

const NWS_TOMORROW_PREFIX_ALLOW = new Set([
  'what', 'whats', "what's", 'how', 'hows', "how's", 'the', 'tell', 'me', 'is',
]);

/**
 * True only for narrow device-location tomorrow weather phrasing.
 * No date parsing, city resolution, or semantic interpretation.
 * False negatives OK; false positives NOT OK.
 */
export function isNwsTomorrowAtDeviceEligible(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;

  const t = raw
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^\w\s'?-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!/\bweather\b/.test(t) || !/\btomorrow\b/.test(t)) return false;
  if (/\btoday\b/.test(t)) return false;
  if (/\bweekend\b/.test(t)) return false;
  if (/\bnext week\b/.test(t)) return false;
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t)) return false;
  if (/\bweather\s+in\b/.test(t)) return false;
  if (/\bin\s+\w/.test(t)) return false;
  if (/\btomorrow\s+in\b/.test(t)) return false;

  const beforeWeather = t.match(/^(\w+(?:'s)?)\s+weather\b/);
  if (beforeWeather && !NWS_TOMORROW_PREFIX_ALLOW.has(beforeWeather[1])) return false;

  return true;
}

function isHumanForecastUrl(url: string): boolean {
  return /^https:\/\/forecast\.weather\.gov\//i.test(url);
}

/** Shallow scan of NWS JSON properties for an official forecast.weather.gov URL. */
function findForecastWeatherGovUrl(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === 'string' && isHumanForecastUrl(value)) return value;
  }
  return null;
}

function resolveSourceLink(apiForecastUrl: string, ...humanCandidates: (string | null | undefined)[]): {
  sourceUrl: string;
  sourceLinkLabel: string;
} {
  for (const candidate of humanCandidates) {
    if (typeof candidate === 'string' && isHumanForecastUrl(candidate)) {
      return { sourceUrl: candidate, sourceLinkLabel: 'View forecast →' };
    }
  }
  if (isHumanForecastUrl(apiForecastUrl)) {
    return { sourceUrl: apiForecastUrl, sourceLinkLabel: 'View forecast →' };
  }
  return { sourceUrl: apiForecastUrl, sourceLinkLabel: 'View NWS source →' };
}

type NwsPeriod = {
  name?: string;
  isDaytime?: boolean;
  shortForecast?: string;
  detailedForecast?: string;
};

function isFiniteCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

async function nwsFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NWS_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/geo+json',
        'User-Agent': NWS_USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function findTomorrowPeriod(periods: NwsPeriod[]): NwsPeriod | null {
  const byLabel = periods.find((p) => /\bTomorrow\b/i.test(p.name ?? ''));
  if (byLabel) return byLabel;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayName = tomorrow.toLocaleDateString('en-US', { weekday: 'long' });
  return periods.find((p) => p.isDaytime !== false && (p.name ?? '').startsWith(dayName)) ?? null;
}

function periodForecastText(period: NwsPeriod): string {
  const short = period.shortForecast?.trim();
  if (short) return short;
  const detailed = period.detailedForecast?.trim();
  if (detailed) return detailed.length > 180 ? `${detailed.slice(0, 177)}…` : detailed;
  return 'Forecast unavailable.';
}

/**
 * Fetch tomorrow's forecast from api.weather.gov for the given coordinates.
 * Returns null on missing coords, HTTP errors, malformed payloads, or timeout.
 */
export async function fetchNwsTomorrowForecast(
  lat: number | null | undefined,
  lng: number | null | undefined,
): Promise<NwsForecastResult | null> {
  if (!isFiniteCoord(lat) || !isFiniteCoord(lng)) return null;

  let pointsRes: Response;
  try {
    pointsRes = await nwsFetch(`${NWS_BASE}/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
  } catch {
    return null;
  }
  if (!pointsRes.ok) return null;

  let pointsBody: unknown;
  try {
    pointsBody = await pointsRes.json();
  } catch {
    return null;
  }

  const forecastUrl = (pointsBody as { properties?: { forecast?: string } })?.properties?.forecast;
  if (typeof forecastUrl !== 'string' || !forecastUrl.startsWith('http')) return null;

  let forecastRes: Response;
  try {
    forecastRes = await nwsFetch(forecastUrl);
  } catch {
    return null;
  }
  if (!forecastRes.ok) return null;

  let forecastBody: unknown;
  try {
    forecastBody = await forecastRes.json();
  } catch {
    return null;
  }

  const periods = (forecastBody as { properties?: { periods?: NwsPeriod[] } })?.properties?.periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;

  const tomorrow = findTomorrowPeriod(periods);
  if (!tomorrow) return null;

  const pointsProps = (pointsBody as { properties?: Record<string, unknown> })?.properties;
  const forecastProps = (forecastBody as { properties?: Record<string, unknown> })?.properties;
  const { sourceUrl, sourceLinkLabel } = resolveSourceLink(
    forecastUrl,
    findForecastWeatherGovUrl(pointsProps),
    findForecastWeatherGovUrl(forecastProps),
  );

  return {
    providerLabel: 'National Weather Service',
    periodTitle: tomorrow.name?.trim() || 'Tomorrow',
    forecastText: periodForecastText(tomorrow),
    sourceUrl,
    sourceLinkLabel,
  };
}
