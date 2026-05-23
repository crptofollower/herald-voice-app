import AsyncStorage from '@react-native-async-storage/async-storage';
import { MIGRATIONS } from './migrations';

// Key that stores the list of migration IDs already completed on this device.
// Never change this key -- it is the source of truth for what has run.
const COMPLETED_KEY = 'herald_completed_migrations';

export const runMigrations = async (): Promise<void> => {
  try {
    // Load list of already-completed migration IDs from this device
    const raw = await AsyncStorage.getItem(COMPLETED_KEY);
    const completed: string[] = raw ? JSON.parse(raw) : [];

    // Find migrations that have not run yet on this device
    const pending = MIGRATIONS.filter(m => !completed.includes(m.id));

    if (pending.length === 0) {
      console.log('[HERALD] Migrations: all up to date');
      return;
    }

    console.log(`[HERALD] Migrations: ${pending.length} pending, running now`);

    for (const migration of pending) {
      try {
        console.log(`[HERALD] Migration starting: ${migration.id} -- ${migration.description}`);
        await migration.run();
        completed.push(migration.id);
        // Write after each migration individually.
        // If the app crashes mid-run, already-completed ones stay recorded.
        await AsyncStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
        console.log(`[HERALD] Migration complete: ${migration.id}`);
      } catch (err) {
        // Log but never crash the app over a migration failure.
        // A partial migration is always better than a broken app.
        console.error(`[HERALD] Migration failed (non-fatal): ${migration.id}`, err);
      }
    }

    console.log('[HERALD] Migrations: all done');

  } catch (err) {
    // Runner itself failed -- log and continue.
    // App must always open even if migrations cannot run.
    console.error('[HERALD] Migration runner error (non-fatal):', err);
  }
};
