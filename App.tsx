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
import * as Font from "expo-font";
import {
  SourceSerif4_300Light,
  SourceSerif4_400Regular,
  SourceSerif4_500Medium,
  SourceSerif4_600SemiBold,
} from "@expo-google-fonts/source-serif-4";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from "./src/store/useStore";
import OnboardingScreen from "./src/screens/OnboardingScreen";
import ChatScreen from "./src/screens/ChatScreen";
import { ONESIGNAL_APP_ID } from "./src/constants/api";
import { runMigrations } from './src/migrations/runMigrations';
import { runMigration } from './src/routing/migration';
import { initDB } from './src/db/useDeviceDB';

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
  const userId               = useStore((s) => s.userId);
  const _hasHydrated       = useStore((s) => s._hasHydrated);
  const hardReset          = useStore((s) => s.hardReset);
  const [sqliteChecked, setSqliteChecked] = useState(false);

  useEffect(() => {
    if (!_hasHydrated) return;
    try {
      const { getProfileField, setProfileField } = require('./src/db/profileDB');
      const sqliteOnboarding = getProfileField('onboarding_complete');

      if (onboardingComplete && sqliteOnboarding !== 'true') {
        // Zustand says onboarded but SQLite has no record.
        // Check if userId exists in SQLite — if yes, this is an existing user
        // predating Build 24. Backfill SQLite and trust Zustand.
        // If no userId anywhere, it is a truly blank install — safe to reset.
        const storeState = require('./src/store/useStore').useStore.getState();
        const sqliteUserId = getProfileField('user_id');

        if (!storeState.userId && !sqliteUserId) {
          // Truly blank — reset to onboarding
          console.warn('[Herald] Blank install detected — resetting');
          hardReset();
        } else {
          // Existing user predating Build 24 — backfill SQLite, preserve state
          setProfileField('onboarding_complete', 'true');
          setProfileField('user_id', storeState.userId);
          if (storeState.name) setProfileField('name', storeState.name);
          if (storeState.aiName) setProfileField('ai_name', storeState.aiName);
          console.log('[Herald] Backfilled SQLite for pre-Build-24 user');
        }
      }
    } catch {
      // SQLite not ready — pass through, next open will catch it
    }
    setSqliteChecked(true);
  }, [_hasHydrated]);

  useEffect(() => {
    if (!_hasHydrated || !sqliteChecked || !onboardingComplete || !userId) return;
    AsyncStorage.getItem('herald_migration_attempts').then(async (attemptsStr) => {
      const attempts = parseInt(attemptsStr ?? '0');
      if (attempts >= 3) return; // give up after 3 failures — user onboards fresh
      try {
        await runMigration(userId);
        await AsyncStorage.removeItem('herald_migration_attempts');
      } catch {
        await AsyncStorage.setItem('herald_migration_attempts', String(attempts + 1));
      }
    });
  }, [_hasHydrated, sqliteChecked, onboardingComplete, userId]);

  if (!_hasHydrated || !sqliteChecked) {
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
      await initDB();
      try {
        await Font.loadAsync({
          "SourceSerif4-Light":    SourceSerif4_300Light,
          "SourceSerif4-Regular":  SourceSerif4_400Regular,
          "SourceSerif4-Medium":   SourceSerif4_500Medium,
          "SourceSerif4-SemiBold": SourceSerif4_600SemiBold,
          "Inter-Regular":         Inter_400Regular,
          "Inter-Medium":          Inter_500Medium,
          "Inter-SemiBold":        Inter_600SemiBold,
          "Inter-Bold":            Inter_700Bold,
        });
      } catch (e) {
        console.warn("[Herald] Font load failed:", e);
      }
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
