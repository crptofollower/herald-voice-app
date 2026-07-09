// scripts/heraldTest/wall1.test.ts
// WALL-1 — the send-path boundary fence (Spine §2 / Routing Law 3).
// A paragraph in the Spine failed to hold this boundary for 43 builds.
// Documents do not hold boundaries. This test does. Fails CLOSED: any key in
// the wire body that is not on the allowlist fails the gate.
import { buildAskWireBody } from '../../src/api/herald.ts';

const ALLOWED = new Set([
  'user_id', 'message', 'local_time', 'local_date', 'lat', 'lng', 'location_label',
]);
const FORBIDDEN = ['device_context', 'history', 'persona', 'active_topics', 'location', 'access_code', 'owner_code'];

const kitchenSink: any = {
  user_id: 'u_test',
  message: 'what do you know about me',
  local_time: '14:03',
  local_date: '2026-07-09',
  lat: 33.09,
  lng: -96.89,
  location_label: 'The Colony, TX',
  history: [{ role: 'user', content: 'my wife is Shannon' }],
  device_context: '[DEVICE CONTEXT] Medical: lisinopril 10mg',
  persona: 'warm',
  active_topics: 'insurance,medications',
  location: 'Davenport FL',
  access_code: 'SECRET',
  owner_code: 'SECRET',
};

export async function runWall1ContractTests() {
  let passed = 0;
  const failures: string[] = [];
  const check = (label: string, cond: boolean) => { cond ? passed++ : failures.push(label); };

  const body = buildAskWireBody(kitchenSink);
  const keys = Object.keys(body);

  for (const k of FORBIDDEN) check(`drops ${k}`, !(k in body));            // 7
  check('no key outside allowlist', keys.every((k) => ALLOWED.has(k)));    // 1
  check('keeps user_id', body.user_id === 'u_test');                      // 1
  check('keeps message', body.message === 'what do you know about me');   // 1
  check('keeps local_time', body.local_time === '14:03');                // 1
  check('keeps local_date', body.local_date === '2026-07-09');           // 1
  check('keeps lat', body.lat === 33.09);                                // 1
  check('keeps lng', body.lng === -96.89);                               // 1
  check('keeps location_label', body.location_label === 'The Colony, TX'); // 1
  const minimal = buildAskWireBody({ user_id: 'u', message: 'hi' } as any);
  check('minimal body = user_id + message only',
    Object.keys(minimal).sort().join(',') === 'message,user_id');        // 1
  // total = 16

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`\x1b[31m❌ WALL-1: ${failures.length} failed\x1b[0m`);
    for (const f of failures) console.log(`   \x1b[31m✗ ${f}\x1b[0m`);
  } else {
    console.log(`\x1b[32m✅ WALL-1: ${passed}/${total} — boundary holds\x1b[0m`);
  }
  return { passed, failed: failures.length, total };
}
