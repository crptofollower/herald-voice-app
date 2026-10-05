// Bounded device-contact lookup for a CALL/SMS turn.
// Herald rows are resolved first. Device contacts are queried only when
// READ_CONTACTS is already granted. This module never requests permission.
// Import, permission status, and contact query share one deadline.
// A native promise that settles after that deadline is ignored.

import {
  osDestinationShape,
  osNameQuery,
  selectPhoneableOsDestinations,
  type OsContactLike,
} from './osContactDestination';

export const DEVICE_CONTACT_NATIVE_DEADLINE_MS = 5_000;

const UNRESOLVED = Symbol('device-contact-native-unresolved');

export type HeraldContactHit = {
  id: string;
  name: string;
  phone?: string | null;
};

export type DeviceContactsFields = {
  PhoneNumbers: string;
  Name: string;
  FirstName: string;
  LastName: string;
};

export type DeviceContactsClient = {
  getPermissionsAsync: () => Promise<{ status?: string | null }>;
  getContactsAsync: (query: { fields: string[] }) => Promise<{ data?: OsContactLike[] | null }>;
  fields: DeviceContactsFields;
};

type DeviceContactClock = {
  now: () => number;
  schedule: (ms: number) => { done: Promise<void>; cancel: () => void };
};

export type ContactPhoneResolution =
  | { phone: string; name: string; contactId?: string; source: 'herald' | 'device' }
  | {
      phone: null;
      name: string;
      source: 'device';
      candidateNames: string[];
      deviceCandidates: { name: string; phone: string }[];
    }
  | null;

function realClock(): DeviceContactClock {
  return {
    now: () => Date.now(),
    schedule(ms: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      return {
        done,
        cancel: () => {
          if (timer !== undefined) clearTimeout(timer);
        },
      };
    },
  };
}

function takeSettledNative<T>(
  promise: Promise<T>,
  remainingMs: number,
  clock: DeviceContactClock,
): Promise<T | typeof UNRESOLVED> {
  if (remainingMs <= 0) return Promise.resolve(UNRESOLVED);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | typeof UNRESOLVED) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let timer: ReturnType<DeviceContactClock['schedule']> | undefined;
    try {
      promise.then(
        (value) => {
          timer?.cancel();
          finish(value);
        },
        () => {
          timer?.cancel();
          finish(UNRESOLVED);
        },
      );
    } catch {
      finish(UNRESOLVED);
      return;
    }
    timer = clock.schedule(remainingMs);
    timer.done.then(() => finish(UNRESOLVED));
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

export async function loadExpoDeviceContactsClient(): Promise<DeviceContactsClient> {
  const Contacts = await import('expo-contacts');
  return {
    getPermissionsAsync: () => Contacts.getPermissionsAsync(),
    getContactsAsync: async (query) => {
      const page = await Contacts.getContactsAsync({
        fields: query.fields as never,
      });
      return { data: page.data ?? null };
    },
    fields: {
      PhoneNumbers: String(Contacts.Fields.PhoneNumbers),
      Name: String(Contacts.Fields.Name),
      FirstName: String(Contacts.Fields.FirstName),
      LastName: String(Contacts.Fields.LastName),
    },
  };
}

export async function resolveContactPhoneLookup(
  nameOrRelation: string,
  deps: {
    findContactByRelationship: (clean: string) => HeraldContactHit | null | undefined;
    findContactByName: (clean: string) => HeraldContactHit | null | undefined;
    loadDeviceContacts: () => Promise<DeviceContactsClient>;
    deadlineMs?: number;
    clock?: DeviceContactClock;
  },
): Promise<ContactPhoneResolution> {
  const clean = nameOrRelation.trim().toLowerCase().replace(/^(?:my|the|a)\s+/, '');

  const byRelation = deps.findContactByRelationship(clean);
  if (byRelation?.phone) {
    return { phone: byRelation.phone, name: byRelation.name, contactId: byRelation.id, source: 'herald' };
  }
  const byName = deps.findContactByName(clean);
  if (byName?.phone) {
    return { phone: byName.phone, name: byName.name, contactId: byName.id, source: 'herald' };
  }

  const osQuery = osNameQuery(nameOrRelation, byRelation?.name ?? byName?.name);
  if (!osQuery) return null;

  const budgetMs = deps.deadlineMs ?? DEVICE_CONTACT_NATIVE_DEADLINE_MS;
  const clock = deps.clock ?? realClock();
  const deadlineAt = clock.now() + budgetMs;
  const remainingMs = () => deadlineAt - clock.now();

  const stage = async <T>(start: () => Promise<T>): Promise<T | typeof UNRESOLVED | null> => {
    const remaining = remainingMs();
    if (remaining <= 0) return UNRESOLVED;
    let promise: Promise<T>;
    try {
      promise = start();
    } catch {
      return null;
    }
    return takeSettledNative(promise, remaining, clock);
  };

  const loaded = await stage(() => deps.loadDeviceContacts());
  if (loaded == null || loaded === UNRESOLVED) return null;
  const loadedObject = asObject(loaded);
  if (
    !loadedObject
    || typeof loadedObject.getPermissionsAsync !== 'function'
    || typeof loadedObject.getContactsAsync !== 'function'
    || !asObject(loadedObject.fields)
  ) return null;
  const client = loaded as DeviceContactsClient;

  const permission = await stage(() => client.getPermissionsAsync());
  if (permission == null || permission === UNRESOLVED) return null;
  const permissionObject = asObject(permission);
  if (!permissionObject || permissionObject.status !== 'granted') return null;

  const page = await stage(() => client.getContactsAsync({
    fields: [
      client.fields.PhoneNumbers,
      client.fields.Name,
      client.fields.FirstName,
      client.fields.LastName,
    ],
  }));
  if (page == null || page === UNRESOLVED) return null;
  const pageObject = asObject(page);
  const rows = pageObject?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let shape: ReturnType<typeof osDestinationShape>;
  try {
    shape = osDestinationShape(selectPhoneableOsDestinations(rows, osQuery), nameOrRelation);
  } catch {
    return null;
  }
  if (!shape) return null;
  if ('candidateNames' in shape) {
    return {
      phone: null,
      name: shape.name,
      source: 'device',
      candidateNames: shape.candidateNames,
      deviceCandidates: shape.deviceCandidates,
    };
  }
  return { phone: shape.phone, name: shape.name, source: 'device' };
}
