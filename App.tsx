// App.tsx -- Herald root
// Navigation: Onboarding (first run) -> Chat (main loop)
//
// CHANGE May 17 2026:
//   Added _hasHydrated check before rendering any screen.
//   Without this, Navigation briefly shows OnboardingScreen during
//   the ~50ms AsyncStorage read, OnboardingScreen fires its speech,
//   then hydration completes and ChatScreen loads with its own greeting.
//   Both play simultaneously. Fix: render nothing until hydrated.

import "react-native-gesture-handler";
import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useStore } from "./src/store/useStore";
import OnboardingScreen from "./src/screens/OnboardingScreen";
import ChatScreen from "./src/screens/ChatScreen";
import { ONESIGNAL_APP_ID } from "./src/constants/api";
import { runMigrations } from './src/migrations/runMigrations';

export type RootStackParamList = {
  Onboarding: undefined;
  Chat: undefined;
};

const Stack = createStackNavigator<RootStackParamList>();

const queryClient = new QueryClient({
  defaultOptions: {
    queries:   { retry: 2, staleTime: 30_000 },
    mutations: { retry: 1 },
  },
});

function Navigation() {
  const onboardingComplete = useStore((s) => s.onboardingComplete);
  const _hasHydrated       = useStore((s) => s._hasHydrated);

  // ── Wait for AsyncStorage to load before rendering any screen ─────────────
  // Without this guard, OnboardingScreen mounts briefly (onboardingComplete
  // is false before hydration), fires its TTS speech, then immediately
  // unmounts when hydration sets onboardingComplete = true. ChatScreen then
  // mounts and fires the greeting. Both voices play at the same time.
  if (!_hasHydrated) {
    return <View style={{ flex: 1, backgroundColor: "#0A1628" }} />;
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!onboardingComplete ? (
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        ) : (
          <Stack.Screen name="Chat" component={ChatScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const init = async () => {
      await runMigrations();
      setReady(true);
    };
    init();
  }, []);

  useEffect(() => {
    if (ONESIGNAL_APP_ID) {
      try {
        const { default: OneSignal } = require("react-native-onesignal");
        OneSignal.initialize(ONESIGNAL_APP_ID);
        OneSignal.Notifications.requestPermission(true);
      } catch {}
    }
  }, []);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="auto" />
        <Navigation />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
