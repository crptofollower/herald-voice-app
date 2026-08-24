// scripts/heraldTest/capabilitySurface.test.ts
// Source-lock: bounded NWS Capability Surface integration in ChatScreen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export async function runCapabilitySurfaceTests() {
  passed = 0;
  failures.length = 0;
  console.log(`\n${BOLD}Capability Surface (source-lock)${RESET}`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const surfaceSrc = fs.readFileSync(path.join(root, 'src/components/CapabilitySurface.tsx'), 'utf8');
  const nwsSrc = fs.readFileSync(path.join(root, 'src/capabilities/nwsWeather.ts'), 'utf8');

  assert(
    'CS-1 CapabilitySurface component — attribution + link',
    surfaceSrc,
    (src) => typeof src === 'string'
      && /providerLabel/.test(src)
      && /periodTitle/.test(src)
      && /forecastText/.test(src)
      && /sourceLinkLabel/.test(src)
      && /View forecast →/.test(src)
      && /onViewForecast/.test(src),
    'providerLabel, periodTitle, forecastText, sourceLinkLabel prop',
  );

  assert(
    'CS-2 CapabilitySurface uses persona tint tokens via props',
    surfaceSrc,
    (src) => typeof src === 'string'
      && /surfaceTint/.test(src)
      && /accent/.test(src),
    'surfaceTint + accent props consumed',
  );

  assert(
    'CS-3 nwsWeather — api.weather.gov + User-Agent + timeout',
    nwsSrc,
    (src) => typeof src === 'string'
      && /api\.weather\.gov/.test(src)
      && /User-Agent/.test(src)
      && /AbortController/.test(src)
      && /fetchNwsTomorrowForecast/.test(src),
    'official NWS endpoint, User-Agent, bounded timeout',
  );

  assert(
    'CS-4 ChatScreen imports CapabilitySurface + fetchNwsTomorrowForecast',
    chatSrc,
    (src) => typeof src === 'string'
      && /from "\.\.\/components\/CapabilitySurface"/.test(src)
      && /from "\.\.\/capabilities\/nwsWeather"/.test(src)
      && /fetchNwsTomorrowForecast/.test(src)
      && /isNwsTomorrowAtDeviceEligible/.test(src),
    'CapabilitySurface + nwsWeather imports incl. eligibility helper',
  );

  assert(
    'CS-5 ChatScreen weatherSurface state typed from NWS result',
    chatSrc,
    (src) => typeof src === 'string'
      && /\[weatherSurface,\s*setWeatherSurface\]/.test(src)
      && /NwsForecastResult/.test(src),
    'weatherSurface state with NwsForecastResult',
  );

  assert(
    'CS-6 sendMessage clears weatherSurface at entry',
    chatSrc,
    (src) => typeof src === 'string'
      && /latLog\('sendMessage entry'[\s\S]*?setWeatherSurface\(null\)/.test(src),
    'setWeatherSurface(null) after sendMessage entry log',
  );

  assert(
    'CS-7 weather proof after mayInvokeBackendStream, before askHeraldStream',
    chatSrc,
    (src) => typeof src === 'string'
      && /mayInvokeBackendStream\(routeDecision\)[\s\S]*?isNwsTomorrowAtDeviceEligible\(text\)[\s\S]*?fetchNwsTomorrowForecast[\s\S]*?askHeraldStream/.test(src),
    'eligibility helper + fetch between mayInvokeBackendStream and askHeraldStream',
  );

  assert(
    'CS-8 NWS success early exit — speak + setWeatherSurface',
    chatSrc,
    (src) => typeof src === 'string'
      && /if \(nwsResult\) \{[\s\S]*?speak\(reply\)[\s\S]*?setWeatherSurface\(nwsResult\)[\s\S]*?sendingRef\.current = false/.test(src),
    'success path speaks, sets surface, resets sendingRef',
  );

  assert(
    'CS-9 CapabilitySurface rendered in ListFooterComponent',
    chatSrc,
    (src) => typeof src === 'string'
      && /ListFooterComponent=\{[\s\S]*?<CapabilitySurface/.test(src)
      && /weatherSurface \?/.test(src),
    'CapabilitySurface in ListFooter when weatherSurface set',
  );

  assert(
    'CS-10 View forecast opens source URL via Linking',
    chatSrc,
    (src) => typeof src === 'string'
      && /sourceLinkLabel=\{weatherSurface\.sourceLinkLabel\}/.test(src)
      && /onViewForecast=\{\(\) => Linking\.openURL\(weatherSurface\.sourceUrl\)\}/.test(src),
    'Linking.openURL(weatherSurface.sourceUrl) + sourceLinkLabel prop',
  );

  assert(
    'CS-11 no tierRouter / routeIntent edits in ChatScreen weather block',
    chatSrc,
    (src) => {
      if (typeof src !== 'string') return false;
      const marker = 'if (isNwsTomorrowAtDeviceEligible(text)';
      const start = src.indexOf(marker);
      const end = src.indexOf('lastInteractionRef.current = now', start);
      const weatherBlock = start >= 0 && end > start ? src.slice(start, end) : '';
      return weatherBlock.length > 0
        && !/tierRouter|routeIntent|classifyQuery|processUtterance/.test(weatherBlock);
    },
    'weather block does not touch routing/classifier',
  );

  assert(
    'CS-12 nwsWeather exports narrow eligibility helper',
    nwsSrc,
    (src) => typeof src === 'string'
      && /export function isNwsTomorrowAtDeviceEligible/.test(src)
      && /\\btomorrow\\b/.test(src)
      && /\\btoday\\b/.test(src)
      && /\\bweekend\\b/.test(src)
      && !/parseDate|resolveCity|geocode/.test(src),
    'isNwsTomorrowAtDeviceEligible with temporal guards, no parsing',
  );

  assert(
    'CS-13 ChatScreen does NOT use broad \\bweather\\b intercept',
    chatSrc,
    (src) => {
      if (typeof src !== 'string') return false;
      const marker = 'if (isNwsTomorrowAtDeviceEligible(text)';
      const start = src.indexOf(marker);
      const end = src.indexOf('lastInteractionRef.current = now', start);
      const weatherBlock = start >= 0 && end > start ? src.slice(start, end) : '';
      return weatherBlock.length > 0 && !weatherBlock.includes('/\\bweather\\b/i.test(text)');
    },
    'no broad weather regex in NWS intercept block',
  );

  assert(
    'CS-14 nwsWeather sourceLinkLabel — API vs human forecast URL',
    nwsSrc,
    (src) => typeof src === 'string'
      && /sourceLinkLabel/.test(src)
      && /View NWS source →/.test(src)
      && /View forecast →/.test(src)
      && /forecast\.weather\.gov/.test(src),
    'resolveSourceLink distinguishes API vs forecast.weather.gov',
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}CapabilitySurface: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('capabilitySurface.test.ts')) {
  runCapabilitySurfaceTests().catch(console.error);
}
