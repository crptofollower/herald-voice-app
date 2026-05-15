// App.tsx -- Herald root
// Navigation: Onboarding (first run) -> Chat (main loop)
// Providers: React Query, Zustand (via store)
// OneSignal initialized here

import "react-native-gesture-handler";
import React, { useEffect } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
if (ONESIGNAL_APP_ID) {
  OneSignal.initialize(ONESIGNAL_APP_ID);
  OneSignal.Notifications.requestPermission(true);
}
import { useStore } from "./src/store/useStore";
import OnboardingScreen from "./src/screens/OnboardingScreen";
import ChatScreen from "./src/screens/ChatScreen";
import { ONESIGNAL_APP_ID } from "./src/constants/api";

export type RootStackParamList = {
  Onboarding: undefined;
  Chat: undefined;
};

const Stack = createStackNavigator<RootStackParamList>();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
    },
    mutations: {
      retry: 1,
    },
  },
});

function Navigation() {
  const onboardingComplete = useStore((s) => s.onboardingComplete);

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
  useEffect(() => {
    if (ONESIGNAL_APP_ID) {
      OneSignal.initialize(ONESIGNAL_APP_ID);
      OneSignal.Notifications.requestPermission(true);
    }
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="auto" />
        <Navigation />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
