import { NativeModules, Platform } from 'react-native';

type JourneyHost = typeof import('./androidJourneyHost');

/** Journey JS host loads only when the native DebugJourneyBridge exists (journey build). */
export function loadJourneyHost(): JourneyHost | null {
  if (Platform.OS !== 'android') return null;
  try {
    const bridge = (NativeModules as { DebugJourneyBridge?: unknown }).DebugJourneyBridge;
    if (!bridge) return null;
    return require('./androidJourneyHost') as JourneyHost;
  } catch {
    return null;
  }
}
