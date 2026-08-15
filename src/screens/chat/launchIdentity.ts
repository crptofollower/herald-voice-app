// src/screens/chat/launchIdentity.ts
// App-launch identity only. Maps a spoken/written app name onto the
// handleLaunchAction registry key. Not a general name normalizer —
// not used by contacts, medical, or any other domain.

const CANONICAL_KEYS: Record<string, string> = {
  aa: 'americanairlines',
  bofa: 'bankofamerica',
  amex: 'americanexpress',
  max: 'hbomax',
  marriott: 'marriottbonvoy',
  shealth: 'health',
  samsunghealth: 'health',
  samsungwallet: 'samsungpay',
  x: 'twitter',
  express_scripts: 'expressscripts',
  expressscripts_app: 'expressscripts',
  mail: 'email',
  inbox: 'email',
  myemail: 'email',
  myinbox: 'email',
  mymail: 'email',
  appletvplus: 'appletv',
};

export function canonicalKey(k: string): string {
  const base = k.toLowerCase().trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '')
    .replace(/\+/g, 'plus');
  return CANONICAL_KEYS[base] ?? base;
}
