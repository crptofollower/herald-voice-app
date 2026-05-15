import React from "react";
import { View, StyleSheet } from "react-native";
import type { PersonaKey } from "../constants/personas";
import { PERSONAS } from "../constants/personas";

interface Props {
  persona: PersonaKey;
  children: React.ReactNode;
  style?: object;
}

export function PersonaBackground({ persona, children, style }: Props) {
  const colors = PERSONAS[persona]?.colors ?? PERSONAS.herald.colors;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});