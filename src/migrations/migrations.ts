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
      const userId = await AsyncStorage.getItem('userId');
      if (!userId) {
        await AsyncStorage.removeItem('onboardingComplete');
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
