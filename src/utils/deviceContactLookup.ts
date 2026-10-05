// Bounded device-contact lookup for a CALL/SMS turn.
// Herald rows are resolved first. Device contacts are queried only when
// READ_CONTACTS is already granted. This module never requests permission.
// A native promise that settles after the deadline is ignored.

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

function takeSettledNative<T>(promise: Promise<T>, deadlineMs: number): Promise<T | typeof UNRESOLVED> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(UNRESOLVED);
    }, deadlineMs);
    try {
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(UNRESOLVED);
        },
      );
    } catch {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(UNRESOLVED);
    }
  });
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

  const deadlineMs = deps.deadlineMs ?? DEVICE_CONTACT_NATIVE_DEADLINE_MS;
  let client: DeviceContactsClient;
  try {
    const loaded = await takeSettledNative(deps.loadDeviceContacts(), deadlineMs);
    if (loaded === UNRESOLVED) return null;
    client = loaded;
  } catch {
    return null;
  }

  let permissionPromise: Promise<{ status?: string | null }>;
  try {
    permissionPromise = client.getPermissionsAsync();
  } catch {
    return null;
  }
  const permission = await takeSettledNative(permissionPromise, deadlineMs);
  if (permission === UNRESOLVED || permission.status !== 'granted') return null;

  let queryPromise: Promise<{ data?: OsContactLike[] | null }>;
  try {
    queryPromise = client.getContactsAsync({
      fields: [
        client.fields.PhoneNumbers,
        client.fields.Name,
        client.fields.FirstName,
        client.fields.LastName,
      ],
    });
  } catch {
    return null;
  }
  const page = await takeSettledNative(queryPromise, deadlineMs);
  if (page === UNRESOLVED || !page.data?.length) return null;

  const destinations = selectPhoneableOsDestinations(page.data, osQuery);
  const shape = osDestinationShape(destinations, nameOrRelation);
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
