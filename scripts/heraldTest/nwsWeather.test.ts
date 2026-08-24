// scripts/heraldTest/nwsWeather.test.ts
// Unit tests for bounded NWS capability fetch (mocked fetch).

import { fetchNwsTomorrowForecast, isNwsTomorrowAtDeviceEligible } from '../../src/capabilities/nwsWeather.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

let passed = 0;
const failures: string[] = [];

function assert(label: string, got: unknown, pred: (v: unknown) => boolean, expected: string) {
  if (pred(got)) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${label}`);
  } else {
    failures.push(label);
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}expected ${expected} got ${JSON.stringify(got)}${RESET}`);
  }
}

const FORECAST_URL = 'https://api.weather.gov/gridpoints/FWD/97,103/forecast';

function mockNwsFetch(responses: Record<string, { ok?: boolean; status?: number; body?: unknown; throw?: boolean }>) {
  return async (url: string) => {
    const spec = responses[url] ?? responses['*'];
    if (!spec) throw new Error(`unexpected fetch: ${url}`);
    if (spec.throw) throw new Error('network fail');
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      json: async () => spec.body,
    } as Response;
  };
}

export async function runNwsWeatherTests() {
  passed = 0;
  failures.length = 0;
  console.log(`\n${BOLD}NWS Weather Capability${RESET}`);

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = mockNwsFetch({
      'https://api.weather.gov/points/33.0198,-96.6989': {
        body: { properties: { forecast: FORECAST_URL } },
      },
      [FORECAST_URL]: {
        body: {
          properties: {
            periods: [
              { name: 'Tonight', isDaytime: false, shortForecast: 'Clear' },
              { name: 'Tomorrow', isDaytime: true, shortForecast: 'Sunny, high near 82.' },
            ],
          },
        },
      },
    }) as typeof fetch;

    const happy = await fetchNwsTomorrowForecast(33.0198, -96.6989);
    assert(
      'NWS-1 happy path returns tomorrow forecast',
      happy,
      (v) => typeof v === 'object' && v !== null
        && (v as { providerLabel?: string }).providerLabel === 'National Weather Service'
        && (v as { periodTitle?: string }).periodTitle === 'Tomorrow'
        && (v as { forecastText?: string }).forecastText === 'Sunny, high near 82.'
        && (v as { sourceUrl?: string }).sourceUrl === FORECAST_URL
        && (v as { sourceLinkLabel?: string }).sourceLinkLabel === 'View NWS source →',
      'NWS result with Tomorrow period + API source label',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  try {
    globalThis.fetch = mockNwsFetch({
      'https://api.weather.gov/points/33.0198,-96.6989': {
        body: { notProperties: true },
      },
    }) as typeof fetch;

    const malformedPoints = await fetchNwsTomorrowForecast(33.0198, -96.6989);
    assert('NWS-2 malformed points payload → null', malformedPoints, (v) => v === null, 'null');
  } finally {
    globalThis.fetch = originalFetch;
  }

  try {
    globalThis.fetch = mockNwsFetch({
      'https://api.weather.gov/points/33.0198,-96.6989': {
        body: { properties: { forecast: FORECAST_URL } },
      },
      [FORECAST_URL]: {
        body: { properties: { periods: [] } },
      },
    }) as typeof fetch;

    const malformedForecast = await fetchNwsTomorrowForecast(33.0198, -96.6989);
    assert('NWS-3 empty forecast periods → null', malformedForecast, (v) => v === null, 'null');
  } finally {
    globalThis.fetch = originalFetch;
  }

  try {
    globalThis.fetch = mockNwsFetch({
      'https://api.weather.gov/points/33.0198,-96.6989': { throw: true },
    }) as typeof fetch;

    const networkFail = await fetchNwsTomorrowForecast(33.0198, -96.6989);
    assert('NWS-4 network failure → null', networkFail, (v) => v === null, 'null');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert('NWS-5 missing lat → null', await fetchNwsTomorrowForecast(null, -96.6989), (v) => v === null, 'null');
  assert('NWS-6 missing lng → null', await fetchNwsTomorrowForecast(33.0198, undefined), (v) => v === null, 'null');

  try {
    globalThis.fetch = mockNwsFetch({
      'https://api.weather.gov/points/33.0198,-96.6989': {
        body: { properties: { forecast: FORECAST_URL } },
      },
      [FORECAST_URL]: {
        body: {
          properties: {
            periods: [
              { name: 'Tonight', isDaytime: false, shortForecast: 'Clear' },
              { name: 'Monday Night', isDaytime: false, shortForecast: 'Cloudy' },
            ],
          },
        },
      },
    }) as typeof fetch;

    const noTomorrow = await fetchNwsTomorrowForecast(33.0198, -96.6989);
    assert('NWS-7 no tomorrow period → null', noTomorrow, (v) => v === null, 'null');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const ELIGIBLE = [
    "what's the weather tomorrow?",
    'weather tomorrow',
    'what is the weather tomorrow',
    "how's the weather tomorrow",
  ];
  for (const phrase of ELIGIBLE) {
    assert(
      `NWS-8 eligible: "${phrase}"`,
      isNwsTomorrowAtDeviceEligible(phrase),
      (v) => v === true,
      'true',
    );
  }

  const INELIGIBLE = [
    "what's the weather today",
    'weather this weekend',
    'weather on Monday',
    'weather next week',
    'weather in Chicago',
    'Chicago weather tomorrow',
    'weather tomorrow in Dallas',
  ];
  for (const phrase of INELIGIBLE) {
    assert(
      `NWS-9 ineligible: "${phrase}"`,
      isNwsTomorrowAtDeviceEligible(phrase),
      (v) => v === false,
      'false',
    );
  }

  try {
    const HUMAN_URL = 'https://forecast.weather.gov/MapClick.php?lat=33&lon=-96';
    globalThis.fetch = mockNwsFetch({
      'https://api.weather.gov/points/33.0198,-96.6989': {
        body: { properties: { forecast: FORECAST_URL, forecastPage: HUMAN_URL } },
      },
      [FORECAST_URL]: {
        body: {
          properties: {
            periods: [
              { name: 'Tomorrow', isDaytime: true, shortForecast: 'Clear.' },
            ],
          },
        },
      },
    }) as typeof fetch;

    const humanLink = await fetchNwsTomorrowForecast(33.0198, -96.6989);
    assert(
      'NWS-10 human forecast.weather.gov URL → View forecast label',
      humanLink,
      (v) => typeof v === 'object' && v !== null
        && (v as { sourceUrl?: string }).sourceUrl === HUMAN_URL
        && (v as { sourceLinkLabel?: string }).sourceLinkLabel === 'View forecast →',
      'human URL + View forecast label',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}NwsWeather: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('nwsWeather.test.ts')) {
  runNwsWeatherTests().catch(console.error);
}
