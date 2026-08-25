// scripts/heraldTest/nwsLocationReadiness.test.ts
// Source-lock: NWS location readiness via ensureCoords in ChatScreen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNwsTomorrowAtDeviceEligible } from '../../src/capabilities/nwsWeather.ts';

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

function weatherBlock(chatSrc: string): string {
  const marker = 'if (isNwsTomorrowAtDeviceEligible(text))';
  const start = chatSrc.indexOf(marker);
  const end = chatSrc.indexOf('lastInteractionRef.current = now', start);
  return start >= 0 && end > start ? chatSrc.slice(start, end) : '';
}

export async function runNwsLocationReadinessTests() {
  passed = 0;
  failures.length = 0;
  console.log(`\n${BOLD}NWS Location Readiness (source-lock)${RESET}`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const locSrc = fs.readFileSync(path.join(root, 'src/hooks/useLocation.ts'), 'utf8');
  const block = weatherBlock(chatSrc);

  // A — eligible + coords present → NWS unchanged (fetch uses hook lat/lng path)
  assert(
    'NLR-A eligible + coords present keeps direct fetch path',
    block,
    (src) => typeof src === 'string'
      && /let nwsLat = lat/.test(src)
      && /let nwsLng = lng/.test(src)
      && /fetchNwsTomorrowForecast\(nwsLat, nwsLng\)/.test(src),
    'nwsLat/nwsLng from hook then fetchNwsTomorrowForecast',
  );

  // B — eligible + missing coords + readiness succeeds → ensureCoords before fetch
  assert(
    'NLR-B missing coords calls ensureCoords before NWS fetch',
    block,
    (src) => typeof src === 'string'
      && /if \(nwsLat == null \|\| nwsLng == null\)/.test(src)
      && /await ensureCoords\(\)/.test(src)
      && /nwsLat = ready\.lat/.test(src)
      && /fetchNwsTomorrowForecast\(nwsLat, nwsLng\)/.test(src),
    'ensureCoords then assign ready coords before fetch',
  );

  // C — permission/readiness failure → honest reply, no silent offline fallthrough
  assert(
    'NLR-C readiness failure returns honest location reply (no fallthrough)',
    block,
    (src) => typeof src === 'string'
      && /if \(!ready\)/.test(src)
      && /can't get your location right now/.test(src)
      && /return;/.test(src)
      && !/I'm not connected right now/.test(src),
    'location-unavailable reply + early return, not offline pool',
  );

  // D — timeout/error honest failure (ensureCoords returns null on error)
  assert(
    'NLR-D ensureCoords bounded timeout + null on error',
    locSrc,
    (src) => typeof src === 'string'
      && /ENSURE_COORDS_TIMEOUT_MS/.test(src)
      && /Promise\.race/.test(src)
      && /return null/.test(src),
    'timeout race + null return on failure',
  );

  // E — unsupported phrasing never calls readiness for NWS
  assert(
    'NLR-E unsupported phrasing never enters NWS block',
    isNwsTomorrowAtDeviceEligible("what's the weather in dallas tomorrow"),
    (v) => v === false,
    'city-named tomorrow weather is ineligible',
  );
  assert(
    'NLR-E ensureCoords only inside eligibility guard',
    block,
    (src) => typeof src === 'string'
      && block.indexOf('ensureCoords') > block.indexOf('isNwsTomorrowAtDeviceEligible(text)'),
    'ensureCoords nested under eligibility check',
  );

  // F — no hardcoded coords in ensureCoords
  assert(
    'NLR-F ensureCoords has no hardcoded lat/lng literals',
    locSrc,
    (src) => {
      if (typeof src !== 'string') return false;
      const fnStart = src.indexOf('export async function ensureCoords');
      const fnEnd = src.indexOf('export function useLocation', fnStart);
      const body = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : '';
      return body.length > 0
        && !/\blat:\s*-?\d+\.\d+/.test(body)
        && !/\blng:\s*-?\d+\.\d+/.test(body)
        && !/\blatitude:\s*-?\d+/.test(body)
        && !/\blongitude:\s*-?\d+/.test(body);
    },
    'no literal coordinate defaults in ensureCoords',
  );

  // G — existing location consumers ok (useLocation hook signature unchanged)
  assert(
    'NLR-G useLocation hook export preserved',
    locSrc,
    (src) => typeof src === 'string'
      && /export function useLocation\(\): LocationResult/.test(src)
      && /export interface LocationResult/.test(src),
    'useLocation + LocationResult unchanged',
  );
  assert(
    'NLR-G ChatScreen still uses useLocation destructuring',
    chatSrc,
    (src) => typeof src === 'string'
      && /const \{ lat, lng, label: locationLabel, available \} = useLocation\(\)/.test(src),
    'existing useLocation consumer intact',
  );

  // H — routing unchanged (no tierRouter edits in weather block)
  assert(
    'NLR-H weather block does not touch routing',
    block,
    (src) => typeof src === 'string'
      && src.length > 0
      && !/tierRouter|routeIntent|classifyQuery|processUtterance/.test(src),
    'no routing imports or calls in NWS block',
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}NwsLocationReadiness: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('nwsLocationReadiness.test.ts')) {
  runNwsLocationReadinessTests().catch(console.error);
}
