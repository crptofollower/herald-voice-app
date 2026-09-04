// scripts/evidence/evidenceProfiles.mjs
// Packet Builder V1 — CTO-reviewed deterministic evidence profiles.
// Profiles are explicit allow-lists. No user-supplied paths.

/** @typedef {{ id: string, cwd?: string, argv: string[] }} ProfileCommand */

/**
 * @typedef {object} EvidenceProfile
 * @property {string} name
 * @property {string} description
 * @property {string[]} files  repository-relative POSIX paths
 * @property {ProfileCommand[]} commands
 */

/** @type {Record<string, EvidenceProfile>} */
export const EVIDENCE_PROFILES = {
  'calendar-diagnosis': {
    name: 'calendar-diagnosis',
    description:
      'Smallest set for calendar continuation/admission, presentation/reference, ' +
      'routing precedence around deterministic calendar reads, and relevant tests.',
    files: [
      'src/routing/calendarContinuation.ts',
      'src/routing/calendarPresentation.ts',
      'src/routing/processUtterance.ts',
      'src/routing/tierRouter.ts',
      'src/db/calendarCacheDB.ts',
      'scripts/heraldTest/calendarContinuation.test.ts',
      'scripts/heraldTest/calendarPresentation.test.ts',
      'scripts/heraldTest/calendarUnresolvableDate.test.ts',
    ],
    commands: [
      {
        id: 'calendar-focused',
        cwd: 'scripts/heraldTest',
        // Invoke local tsx CLI via node — no shell, no network, no npx.
        argv: [
          'node',
          './node_modules/tsx/dist/cli.mjs',
          '../evidence/runCalendarFocused.mjs',
        ],
      },
    ],
  },

  'routing-diagnosis': {
    name: 'routing-diagnosis',
    description:
      'Core deterministic routing seam: classify → routeIntent → processUtterance + Law 0.',
    files: [
      'src/routing/tierRouter.ts',
      'src/routing/routeIntent.ts',
      'src/routing/processUtterance.ts',
      'scripts/heraldTest/lawZero.test.ts',
      'scripts/heraldTest/pipeline.test.ts',
    ],
    commands: [],
  },

  'memory-diagnosis': {
    name: 'memory-diagnosis',
    description:
      'Bounded conversational subject + hot narrative ring and personal-memory fence tests.',
    files: [
      'src/routing/conversationalSubject.ts',
      'src/utils/hotNarrativeRing.ts',
      'scripts/heraldTest/conversationalSubject.test.ts',
      'scripts/heraldTest/personalMemoryRecallFence.test.ts',
      'scripts/heraldTest/hotNarrativeRing.test.ts',
    ],
    commands: [],
  },
};

export const PROFILE_NAMES = Object.keys(EVIDENCE_PROFILES);

export function getEvidenceProfile(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  return EVIDENCE_PROFILES[name.trim()] ?? null;
}
