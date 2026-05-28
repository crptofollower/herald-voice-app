// PersonaBackground.tsx -- Full-screen scene image background per persona
// Updated May 28 2026
// Build 15: Night wallpaper swap -- hour >= 20 || hour < 6 uses night image.
// Uses real JPG scene images from assets/ folder.
// ImageBackground fills the screen, dark overlay keeps text readable.

import React, { useMemo } from "react";
import { StyleSheet, ImageBackground, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { PERSONAS, type PersonaKey } from "../constants/personas";

// ─── Day images ───────────────────────────────────────────────────────────────

const IMAGES_DAY: Record<PersonaKey, ReturnType<typeof require>> = {
  beach:    require("../../assets/beach.jpg"),
  city:     require("../../assets/city.jpg"),
  country:  require("../../assets/country.jpg"),
  desert:   require("../../assets/desert.jpg"),
  mountain: require("../../assets/mountain.jpg"),
};

// ─── Night images (Build 15) ──────────────────────────────────────────────────

const IMAGES_NIGHT: Record<PersonaKey, ReturnType<typeof require>> = {
  beach:    require("../../assets/beach-night.png"),
  city:     require("../../assets/city-night.png"),
  country:  require("../../assets/country-night.png"),
  desert:   require("../../assets/desert-night.png"),
  mountain: require("../../assets/mountain-night.png"),
};

// Night: 8pm (20:00) through 5:59am. Day: everything else.
function isNightTime(): boolean {
  const hour = new Date().getHours();
  return hour >= 20 || hour < 6;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  persona: PersonaKey;
  children: React.ReactNode;
  style?: object;
}

export function PersonaBackground({ persona, children, style }: Props) {
  // Evaluated once per render -- changes naturally at next open after 8pm/6am.
  // No interval needed: users open the app; it picks the right image then.
  const source = useMemo(
    () => (isNightTime() ? IMAGES_NIGHT[persona] : IMAGES_DAY[persona]),
    [persona]
  );

  return (
    <ImageBackground
      source={source}
      style={[styles.container, style]}
      resizeMode="cover"
    >
      {/* Dark overlay so text stays readable over any scene */}
      <LinearGradient
        colors={PERSONAS[persona].gradient}
        locations={[0, 0.30, 0.62, 1.0]}
        style={StyleSheet.absoluteFill}
      />
      {/* Content sits above overlay */}
      <View style={styles.content}>
        {children}
      </View>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
});
