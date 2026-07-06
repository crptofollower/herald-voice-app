// Test-only stub for the 'react-native' package.
// esbuild (via tsx) cannot parse react-native's real entry file (Flow syntax).
// Nothing in the gate needs real native behavior — only inert named exports
// so that expo-sqlite / expo-calendar / expo-contacts (which import from
// 'react-native' internally) resolve without crashing the transform.
// If a future gate addition throws "no export named X from react-native",
// add a harmless stand-in for X here — same shim pattern as setDB() in schema.ts.

export const Platform = {
  OS: 'android',
  select: (obj: Record<string, unknown>) => obj.android ?? obj.default,
};

export const processColor = (color: unknown) => color;

export const Share = {
  share: async () => ({ action: 'dismissedAction' }),
};

export const NativeModules = {};

export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
};

export const Linking = {
  openURL: async () => {},
  canOpenURL: async () => false,
};

export const Dimensions = {
  get: () => ({ width: 0, height: 0 }),
};

export const StyleSheet = {
  create: (styles: Record<string, unknown>) => styles,
};
