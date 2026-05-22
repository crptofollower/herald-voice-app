// PersonaBackground.tsx -- Full-screen scene image background per persona
// Updated May 15 2026
// Uses real JPG scene images from assets/ folder.
// ImageBackground fills the screen, dark overlay keeps text readable.

import React from "react";
import { StyleSheet, ImageBackground, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { PERSONAS, type PersonaKey } from "../constants/personas";

// ─── Scene images ─────────────────────────────────────────────────────────────

const IMAGES: Record<PersonaKey, ReturnType<typeof require>> = {
  beach:    require("../../assets/beach.jpg"),
  city:     require("../../assets/city.jpg"),
  country:  require("../../assets/country.jpg"),
  desert:   require("../../assets/desert.jpg"),
  mountain: require("../../assets/mountain.jpg"),
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  persona: PersonaKey;
  children: React.ReactNode;
  style?: object;
}

export function PersonaBackground({ persona, children, style }: Props) {
  return (
    <ImageBackground
      source={IMAGES[persona]}
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
