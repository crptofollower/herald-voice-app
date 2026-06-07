// PersonaBackground.tsx -- Full-screen scene image background per persona
// Updated May 28 2026
// Build 15: Night wallpaper swap -- hour >= 20 || hour < 6 uses night image.
// Uses real JPG scene images from assets/ folder.
// ImageBackground fills the screen, dark overlay keeps text readable.

import React from "react";
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

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  persona: PersonaKey;
  children: React.ReactNode;
  style?: object;
}

export function PersonaBackground({ persona: personaKey, children, style }: Props) {
  const persona = {
    ...PERSONAS[personaKey],
    wallpaper: IMAGES_DAY[personaKey],
    wallpaperNight: IMAGES_NIGHT[personaKey],
  };

  const hour = new Date().getHours();
  const isNight = hour >= 20 || hour < 6;
  const imageSource = isNight && persona.wallpaperNight
    ? persona.wallpaperNight
    : persona.wallpaper;

  return (
    <ImageBackground
      source={imageSource}
      style={[styles.container, style]}
      resizeMode="cover"
    >
      {/* Dark overlay so text stays readable over any scene */}
      <LinearGradient
        colors={persona.gradient}
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
