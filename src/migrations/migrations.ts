import AsyncStorage from '@react-native-async-storage/async-storage';

// ─────────────────────────────────────────────────────────────────────────────
// HERALD MIGRATION REGISTRY
//
// Rules:
// - Never delete a migration. Never change a migration's id.
// - Add new migrations at the BOTTOM of the array only.
// - Each migration runs exactly once per device, ever.
// - Migrations are surgical -- only touch what actually changed.
// - A migration that wipes data should be a last resort and clearly commented.
// ─────────────────────────────────────────────────────────────────────────────

export interface Migration {
  id: string;
  description: string;
  run: () => Promise<void>;
}

export const MIGRATIONS: Migration[] = [

  // ─── v8.16.0 ──────────────────────────────────────────────────────────────
  {
    id: 'v8.16_fix_onboarding_flag',
    description: 'Clear stuck onboardingComplete flag when userId is absent. ' +
                 'Fixes: fresh APK install skips onboarding because old flag persists.',
    run: async () => {
      // The Zustand store persists as one JSON blob under
      // 'herald-store-v3'. On reinstall, this blob survives
      // with onboardingComplete: true but the server profile
      // is gone. This migration detects that and resets the flag.
      try {
        const raw = await AsyncStorage.getItem('herald-store-v3');
        if (!raw) return; // fresh install -- nothing to fix
        const store = JSON.parse(raw);
        const state  = store?.state ?? {};
        const userId = (state.userId ?? '').trim();
        const name   = (state.name   ?? '').trim();
        if (!userId || !name) {
          // userId or name missing -- onboarding was never completed
          store.state.onboardingComplete = false;
          await AsyncStorage.setItem(
            'herald-store-v3',
            JSON.stringify(store)
          );
          console.log('[Migration] v8.16_fix_onboarding_flag: reset stuck flag');
        }
      } catch (e) {
        console.error('[Migration] v8.16_fix_onboarding_flag (non-fatal):', e);
      }
    },
  },

  {
    id: 'v8.16_fix_ai_name_default',
    description: 'Ensure aiName has a value if missing from AsyncStorage.',
    run: async () => {
      const aiName = await AsyncStorage.getItem('aiName');
      if (!aiName) {
        await AsyncStorage.setItem('aiName', 'Herald');
      }
    },
  },

  // ─── v8.17.0 ──────────────────────────────────────────────────────────────
  {
    id: 'v8_17_force_onboarding_reset',
    description:
      'Reset onboardingComplete when onboarding was marked done but aiName or name ' +
      'are still defaults (missing or "Herald").',
    run: async () => {
      try {
        const raw = await AsyncStorage.getItem('herald-store-v3');
        if (!raw) return;
        const store = JSON.parse(raw);
        const state = store?.state ?? {};
        const onboardingComplete = state.onboardingComplete === true;
        const aiName = (state.aiName ?? '').trim();
        const name = (state.name ?? '').trim();

        const aiNameIsDefault = !aiName || aiName === 'Herald';
        const nameIsDefault = !name || name === 'Herald';

        const shouldReset =
          (onboardingComplete && aiNameIsDefault) || nameIsDefault;

        if (!shouldReset) return;

        store.state.onboardingComplete = false;
        await AsyncStorage.setItem('herald-store-v3', JSON.stringify(store));
        console.log('[Migration] v8_17_force_onboarding_reset: reset onboarding flag');
      } catch (e) {
        console.error('[Migration] v8_17_force_onboarding_reset (non-fatal):', e);
      }
    },
  },

  // ─── FUTURE MIGRATIONS GO HERE ────────────────────────────────────────────
  // Example pattern -- uncomment and fill when needed:
  //
  // {
  //   id: 'v8.17_example_migration',
  //   description: 'What this migration does and why it was needed.',
  //   run: async () => {
  //     const old = await AsyncStorage.getItem('oldKey');
  //     if (old) {
  //       await AsyncStorage.setItem('newKey', old);
  //       await AsyncStorage.removeItem('oldKey');
  //     }
  //   },
  // },

];
