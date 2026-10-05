// Bounded device-contact lookup. Native permission/query awaits cannot hold a call turn.
// Runner: npx tsx scripts/heraldTest/deviceContactLookupBound.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_CONTACT_NATIVE_DEADLINE_MS,
  resolveContactPhoneLookup,
  type DeviceContactsClient,
  type HeraldContactHit,
} from '../../src/utils/deviceContactLookup';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PERSON = 'Jordan';
const FIELDS = { PhoneNumbers: 'phoneNumbers', Name: 'name', FirstName: 'firstName', LastName: 'lastName' };

function none(): HeraldContactHit | null {
  return null;
}

function herald(phone: string): HeraldContactHit {
  return { id: 'c1', name: PERSON, phone };
}

function row(name: string, phone: string) {
  return { name, phoneNumbers: [{ number: phone }] };
}

function client(partial: Partial<DeviceContactsClient> & { requestPermissionsAsync?: () => Promise<unknown> }): DeviceContactsClient & { requestPermissionsAsync?: () => Promise<unknown> } {
  return {
    getPermissionsAsync: async () => ({ status: 'granted' }),
    getContactsAsync: async () => ({ data: [] }),
    fields: FIELDS,
    ...partial,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function devicePhone(hit: { phone?: string | null; source?: string; name?: string } | null): string | null {
  if (!hit || hit.phone == null || hit.source !== 'device' || hit.name !== PERSON) return null;
  return hit.phone;
}

function ambiguousCount(hit: { phone?: string | null; deviceCandidates?: { name: string; phone: string }[] } | null): number {
  if (!hit || hit.phone !== null) return -1;
  return hit.deviceCandidates?.length ?? -1;
}

export async function runDeviceContactLookupBoundTests() {
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Device contact lookup bound ---------------------------${RESET}\n`);

  {
    let loaded = 0;
    const hit = await resolveContactPhoneLookup(`my ${PERSON}`, {
      findContactByRelationship: () => herald('5551112222'),
      findContactByName: none,
      loadDeviceContacts: async () => { loaded++; return client({}); },
    });
    assert('local relationship match resolves without device contacts',
      { phone: hit && 'phone' in hit ? hit.phone : null, source: hit && 'source' in hit ? hit.source : null, loaded },
      (v) => (v as { phone: string; source: string; loaded: number }).phone === '5551112222'
        && (v as { source: string }).source === 'herald'
        && (v as { loaded: number }).loaded === 0,
      'herald phone, device loader not called');
  }

  {
    let loaded = 0;
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: () => herald('5553334444'),
      loadDeviceContacts: async () => { loaded++; return client({}); },
    });
    assert('local name match resolves without device contacts',
      { phone: hit && 'phone' in hit ? hit.phone : null, loaded },
      (v) => (v as { phone: string; loaded: number }).phone === '5553334444' && (v as { loaded: number }).loaded === 0,
      'herald phone, device loader not called');
  }

  {
    let queried = 0;
    let requested = 0;
    const denied = client({
      getPermissionsAsync: async () => ({ status: 'undetermined' }),
      getContactsAsync: async () => { queried++; return { data: [row(PERSON, '5550001111')] }; },
      requestPermissionsAsync: async () => { requested++; return { status: 'granted' }; },
    });
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: async () => denied,
      deadlineMs: 50,
    });
    assert('permission not granted returns unresolved', hit, (v) => v === null, 'null');
    assert('permission not granted does not query contacts', queried, (v) => v === 0, '0 queries');
    assert('permission not granted does not call requestPermissionsAsync', requested, (v) => v === 0, '0 requests');
  }

  {
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: async () => client({
        getPermissionsAsync: async () => { throw new Error('permission bridge down'); },
      }),
      deadlineMs: 50,
    });
    assert('permission-status rejection returns unresolved', hit, (v) => v === null, 'null');
  }

  {
    let queried = 0;
    let release: (value: { status: string }) => void = () => {};
    const hung = new Promise<{ status: string }>((resolve) => { release = resolve; });
    const started = Date.now();
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: async () => client({
        getPermissionsAsync: () => hung,
        getContactsAsync: async () => { queried++; return { data: [row(PERSON, '5550001111')] }; },
      }),
      deadlineMs: 40,
    });
    const elapsed = Date.now() - started;
    assert('permission-status never resolves returns unresolved', hit, (v) => v === null, 'null');
    assert('permission-status deadline is bounded', elapsed, (v) => typeof v === 'number' && v < 1000, 'under 1s');
    release({ status: 'granted' });
    await sleep(20);
    assert('late permission grant does not query contacts or change the result', queried, (v) => v === 0, '0 queries after late grant');
  }

  {
    let release: (value: { data: ReturnType<typeof row>[] }) => void = () => {};
    const hung = new Promise<{ data: ReturnType<typeof row>[] }>((resolve) => { release = resolve; });
    const started = Date.now();
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: async () => client({
        getContactsAsync: () => hung,
      }),
      deadlineMs: 40,
    });
    const elapsed = Date.now() - started;
    assert('contacts query never resolves returns unresolved', hit, (v) => v === null, 'null');
    assert('contacts query deadline is bounded', elapsed, (v) => typeof v === 'number' && v < 1000, 'under 1s');
    release({ data: [row(PERSON, '5550009999')] });
    await sleep(20);
    assert('late contacts query cannot become a resolved phone', hit, (v) => v === null, 'still null');
  }

  {
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: async () => client({
        getContactsAsync: async () => { throw new Error('provider failed'); },
      }),
      deadlineMs: 50,
    });
    assert('contacts query throw returns unresolved', hit, (v) => v === null, 'null');
  }

  {
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: async () => { throw new Error('module unavailable'); },
      deadlineMs: 50,
    });
    assert('unavailable contacts module returns unresolved', hit, (v) => v === null, 'null');
  }

  {
    let release: (value: DeviceContactsClient) => void = () => {};
    const hung = new Promise<DeviceContactsClient>((resolve) => { release = resolve; });
    const started = Date.now();
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: () => hung,
      deadlineMs: 40,
    });
    const elapsed = Date.now() - started;
    assert('contacts module load never resolves returns unresolved', hit, (v) => v === null, 'null');
    assert('contacts module load deadline is bounded', elapsed, (v) => typeof v === 'number' && v < 1000, 'under 1s');
    release(client({}));
    await sleep(20);
    assert('late contacts module load cannot become a resolved phone', hit, (v) => v === null, 'still null');
  }

  {
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: async () => client({
        getContactsAsync: async () => ({ data: [row(PERSON, '555-010-0199')] }),
      }),
      deadlineMs: 50,
    });
    assert('granted permission and one device contact resolves',
      devicePhone(hit),
      (v) => v === '5550100199',
      'device phone 5550100199');
  }

  {
    const hit = await resolveContactPhoneLookup(PERSON, {
      findContactByRelationship: none,
      findContactByName: none,
      loadDeviceContacts: async () => client({
        getContactsAsync: async () => ({ data: [row('Jordan A', '5550100101'), row('Jordan B', '5550100102')] }),
      }),
      deadlineMs: 50,
    });
    assert('granted permission with two device contacts stays unresolved for dial',
      ambiguousCount(hit),
      (v) => v === 2,
      'phone null, two candidates');
  }

  const helperSrc = fs.readFileSync(path.join(ROOT, 'src/utils/deviceContactLookup.ts'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(ROOT, 'src/screens/ChatScreen.tsx'), 'utf8');
  const fnStart = chatSrc.indexOf('const resolveContactPhone =');
  const fnEnd = chatSrc.indexOf('resolveContactPhoneRef.current = resolveContactPhone');
  const fnBody = chatSrc.slice(fnStart, fnEnd);
  assert('device lookup helper never requests contacts permission',
    helperSrc.includes('requestPermissionsAsync'),
    (v) => v === false,
    'no requestPermissionsAsync');
  assert('device lookup helper does not launch a call or SMS',
    /Linking|openURL|tel:|sms:/.test(helperSrc),
    (v) => v === false,
    'no Linking or tel/sms');
  assert('call-route resolver does not request contacts permission',
    fnBody.includes('requestPermissionsAsync'),
    (v) => v === false,
    'resolveContactPhone has no requestPermissionsAsync');
  assert('call-route resolver uses the bounded lookup',
    fnBody.includes('resolveContactPhoneLookup') && fnBody.includes('loadExpoDeviceContactsClient'),
    (v) => v === true,
    'resolveContactPhoneLookup');
  assert('native contacts deadline is 5 seconds',
    DEVICE_CONTACT_NATIVE_DEADLINE_MS,
    (v) => v === 5_000,
    '5000');

  const total = passed + failures.length;
  console.log(`\n${BOLD}DeviceContactLookupBound: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('deviceContactLookupBound.test.ts')) {
  runDeviceContactLookupBoundTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
