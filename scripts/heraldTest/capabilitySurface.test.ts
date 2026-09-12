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
  const frameSrc = fs.readFileSync(path.join(root, 'src/components/CapabilitySurfaceFrame.tsx'), 'utf8');
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
    'CS-5 ChatScreen weather occupies the shared activeSurface slot',
    chatSrc,
    (src) => typeof src === 'string'
      && /kind: 'weather'/.test(src)
      && /NwsForecastResult/.test(src)
      && /activeSurface/.test(src),
    'activeSurface weather kind with NwsForecastResult',
  );

  assert(
    'CS-6 sendMessage clears weather slot at entry without clearing grocery',
    chatSrc,
    (src) => typeof src === 'string'
      && /latLog\('sendMessage entry'[\s\S]*?setActiveSurface\(\(prev\) => \(prev\?\.kind === 'weather' \? null : prev\)\)/.test(src),
    'weather-only slot clear after sendMessage entry log',
  );

  assert(
    'CS-7 weather proof after mayInvokeBackendStream, before askHeraldStream',
    chatSrc,
    (src) => typeof src === 'string'
      && /mayInvokeBackendStream\(routeDecision\)[\s\S]*?isNwsTomorrowAtDeviceEligible\(text\)[\s\S]*?fetchNwsTomorrowForecast[\s\S]*?askHeraldStream/.test(src),
    'eligibility helper + fetch between mayInvokeBackendStream and askHeraldStream',
  );

  assert(
    'CS-8 NWS success early exit — speak + set weather activeSurface',
    chatSrc,
    (src) => typeof src === 'string'
      && /if \(nwsResult\) \{[\s\S]*?speak\(reply\)[\s\S]*?setActiveSurface\(\{ kind: 'weather', weather: nwsResult \}\)[\s\S]*?sendingRef\.current = false/.test(src),
    'success path speaks, sets weather slot, resets sendingRef',
  );

  assert(
    'CS-9 CapabilitySurface rendered in ListFooterComponent',
    chatSrc,
    (src) => typeof src === 'string'
      && /ListFooterComponent=\{[\s\S]*?<CapabilitySurface/.test(src)
      && /activeSurface\?\.kind === 'weather'/.test(src),
    'CapabilitySurface in ListFooter when weather occupies the slot',
  );

  assert(
    'CS-10 View forecast opens source URL via Linking',
    chatSrc,
    (src) => typeof src === 'string'
      && /sourceLinkLabel=\{activeSurface\.weather\.sourceLinkLabel\}/.test(src)
      && /onViewForecast=\{\(\) => Linking\.openURL\(activeSurface\.weather\.sourceUrl\)\}/.test(src),
    'Linking.openURL(activeSurface.weather.sourceUrl) + sourceLinkLabel prop',
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

  assert(
    'CS-15 presentation — attribution, period, forecast, dynamic CTA rendered',
    surfaceSrc,
    (src) => typeof src === 'string'
      && /\{providerLabel\}/.test(src)
      && /\{periodTitle\}/.test(src)
      && /\{forecastText\}/.test(src)
      && /\{sourceLinkLabel\}/.test(src)
      && /onPress=\{onViewForecast\}/.test(src),
    'existing fields rendered; CTA still calls onViewForecast',
  );

  assert(
    'CS-16 no second dismiss / No-thanks / filled CTA / emoji title',
    surfaceSrc,
    (src) => typeof src === 'string'
      && !/No thanks/i.test(src)
      && !/onDismiss/.test(src)
      && !/accessibilityRole="button"/.test(src)
      && !/backgroundColor:[\s\S]{0,40}onViewForecast/.test(src)
      && !/emoji|🌤|☀️|☁️/.test(src)
      && /accessibilityRole="link"/.test(src)
      && /minHeight:\s*44/.test(src),
    'single understated link CTA; 44dp target; no dismiss or emoji title',
  );

  assert(
    'CS-17 inset grammar — no heavy boxed modal treatment',
    surfaceSrc + '\n' + frameSrc,
    (src) => typeof src === 'string'
      && /variant="inset"/.test(src)
      && /borderLeftWidth:\s*2/.test(src)
      && !/borderWidth:\s*[2-9]/.test(src)
      && !/numberOfLines=\{3\}/.test(src)
      && !/textTransform:\s*'uppercase'/.test(src)
      && /styles\.inset/.test(src),
    'left-edge inset via shared frame; forecast height unconstrained; no uppercase brand header',
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}CapabilitySurface: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('capabilitySurface.test.ts')) {
  runCapabilitySurfaceTests().catch(console.error);
}
