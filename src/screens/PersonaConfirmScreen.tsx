// PersonaConfirmScreen.tsx — Screen 2: cinematic flash after persona pick

import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableWithoutFeedback,
  ImageBackground,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { PERSONAS, type PersonaKey } from "../constants/personas";
import { PERSONA_IMAGES } from "../constants/personaImages";

interface Props {
  personaKey: PersonaKey;
  aiName: string;
  onComplete: () => void;
}

export default function PersonaConfirmScreen({
  personaKey,
  aiName,
  onComplete,
}: Props) {
  const persona = PERSONAS[personaKey];
  const displayName = aiName.trim() || "Herald";

  const photoOpacity = useRef(new Animated.Value(0)).current;
  const nameOpacity = useRef(new Animated.Value(0)).current;
  const nameTranslateY = useRef(new Animated.Value(12)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const finishedRef = useRef(false);

  const finish = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onComplete();
  };

  useEffect(() => {
    const timer = setTimeout(finish, 1500);

    Animated.timing(photoOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();

    Animated.parallel([
      Animated.timing(nameOpacity, {
        toValue: 1,
        duration: 500,
        delay: 300,
        useNativeDriver: true,
      }),
      Animated.timing(nameTranslateY, {
        toValue: 0,
        duration: 500,
        delay: 300,
        useNativeDriver: true,
      }),
    ]).start();

    Animated.sequence([
      Animated.delay(800),
      Animated.timing(glowOpacity, {
        toValue: 0.7,
        duration: 350,
        useNativeDriver: true,
      }),
      Animated.timing(glowOpacity, {
        toValue: 0.5,
        duration: 350,
        useNativeDriver: true,
      }),
    ]).start();

    return () => clearTimeout(timer);
  }, [photoOpacity, nameOpacity, nameTranslateY, glowOpacity]);

  return (
    <TouchableWithoutFeedback onPress={finish} accessibilityRole="button">
      <View style={styles.container}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: photoOpacity }]}>
          <ImageBackground
            source={PERSONA_IMAGES[personaKey]}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        </Animated.View>

        <LinearGradient
          colors={[
            "rgba(0,0,0,0.3)",
            "rgba(0,0,0,0.08)",
            "rgba(0,0,0,0.6)",
          ]}
          locations={[0, 0.3, 1]}
          style={StyleSheet.absoluteFill}
        />

        <View style={styles.center}>
          <Animated.View
            style={[
              styles.glow,
              {
                backgroundColor: persona.accent,
                opacity: glowOpacity,
              },
            ]}
          />
          <Animated.Text
            style={[
              styles.name,
              {
                opacity: nameOpacity,
                transform: [{ translateY: nameTranslateY }],
              },
            ]}
          >
            {displayName}
          </Animated.Text>
          <Animated.Text
            style={[
              styles.subtitle,
              { opacity: nameOpacity },
            ]}
          >
            ready when you are
          </Animated.Text>
        </View>
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  glow: {
    position: "absolute",
    width: 200,
    height: 200,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 80,
    elevation: 20,
  },
  name: {
    fontFamily: "SourceSerif4-Regular",
    fontSize: 72,
    color: "#ffffff",
    letterSpacing: -0.025 * 72,
    textAlign: "center",
  },
  subtitle: {
    marginTop: 12,
    fontFamily: "Inter-Regular",
    fontSize: 14,
    color: "rgba(255,255,255,0.6)",
    textAlign: "center",
  },
});
