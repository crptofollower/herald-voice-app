// OnboardingScreen.tsx -- Voice-first guided onboarding
// Updated May 17 2026
//
// CHANGE: Added "ainame" step between "name" and "persona".
//   Step 6: "What should I call you?" -> user name
//   Step 7: "What would you like to call me?" -> AI name (default: Herald)
//   Step 8: Persona picker
//
// This is the personalization hook. The AI name follows the user everywhere:
// the app header, the greeting, every response. It is the product's identity.

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Animated,
  Image,
  ImageBackground,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import { Audio } from "expo-av";
import { PERSONAS, type PersonaKey } from "../constants/personas";
import { PERSONA_IMAGES } from "../constants/personaImages";
import PersonaConfirmScreen from "./PersonaConfirmScreen";
import { useStore } from "../store/useStore";
import { API_BASE } from "../constants/api";
import { saveLocalProfile } from "../hooks/useDeviceMemory";
import { writeProfileFromOnboarding } from '../routing/tier1Responses';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = "code" | "name" | "ainame" | "promise" | "notify" | "location" | "mic" | "persona" | "confirm";

const PERSONA_KEYS = Object.keys(PERSONAS) as PersonaKey[];

const BG_TOP    = "#0A1628";
const BG_BOTTOM = "#0D2440";
const ACCENT    = "#1A9B8A";

const HERALD_SPEECH: Record<string, string> = {
  code:     "Let's get you set up. I will walk you through it one step at a time. Nothing here is permanent.",
  name:     "Who do I have the pleasure of meeting? Just your first name is perfect.",
  ainame:   "Good to meet you. What would you like to call me? Pick a name that feels easy to say out loud.",
  promise:  "Before I ask you for anything, I want to make you three promises. I will not sell what I know about you. I do not track where you go. I only look when it helps you.",
  notify:   "Can I tap you on the shoulder? So I can let you know when something happens. A score you follow, a price you are watching. You decide what is worth a tap.",
  location: "Can I see where you are? So I can tell you if it is raining, point you to a good place nearby, or help if you are ever lost. I only check when you ask. Never in the background.",
  mic:      "Can I hear you? So you can just talk to me instead of typing. I only listen the moment you tap the mic. I never record or keep your voice.",
  persona:  "Where do you feel most at home? I will take my colors from the place you pick.",
};

// ─── Speak helper ─────────────────────────────────────────────────────────────

// Android TTS has a ~200 char limit per utterance and chokes on em dashes.
// Split on sentence boundaries and queue them so nothing gets cut off.
function heraldSpeak(text: string) {
  Speech.stop();
  const sentences = text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return;
  // Speak first sentence immediately, queue the rest
  sentences.forEach((sentence, i) => {
    setTimeout(() => {
      Speech.speak(sentence, { rate: 0.92, pitch: 1.0 });
    }, i * 50); // small stagger so Android queues correctly
  });
}

// ─── Fade wrapper ─────────────────────────────────────────────────────────────

function FadeIn({ children }: { children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);
  return <Animated.View style={[{ flex: 1 }, { opacity }]}>{children}</Animated.View>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const [step, setStep]               = useState<Step>("code");
  const [accessCode, setAccessCode]   = useState("");
  const [codeError, setCodeError]     = useState("");
  const [name, setName]               = useState("");
  const [aiName, setAiName]           = useState("");          // NEW: what user calls Herald
  const [persona, setPersonaKey]      = useState<PersonaKey>("city");
  const [isSubmitting, setSubmitting] = useState(false);

  const scaleAnims = useRef(
    PERSONA_KEYS.reduce(
      (acc, k) => ({
        ...acc,
        [k]: new Animated.Value(k === "city" ? 1.01 : 1),
      }),
      {} as Record<PersonaKey, Animated.Value>
    )
  ).current;

  const { setUser, setPersona, setOnboardingComplete, setOwner, setAiName: storeSetAiName } = useStore();

  // Speak on step change
  useEffect(() => {
    const text = HERALD_SPEECH[step];
    if (text) {
      const t = setTimeout(() => heraldSpeak(text), 300);
      return () => clearTimeout(t);
    }
  }, [step]);

  useEffect(() => () => { Speech.stop(); }, []);

  const BEACH_IMAGE = require("../../assets/beach.jpg");

  const BeachBg = ({ children }: { children: React.ReactNode }) => (
    <ImageBackground
      source={BEACH_IMAGE}
      style={{ flex: 1 }}
      resizeMode="cover"
    >
      <LinearGradient
        colors={["rgba(13,18,23,0.88)", "rgba(13,18,23,0.78)", "rgba(13,18,23,0.85)"]}
        locations={[0, 0.5, 1]}
        style={{ flex: 1 }}
      >
        <FadeIn>{children}</FadeIn>
      </LinearGradient>
    </ImageBackground>
  );

  // ── Permission helpers ────────────────────────────────────────────────────
  const requestMic = async () => {
    try { await Audio.requestPermissionsAsync(); } catch {}
    setStep("persona");
  };

  const requestLocation = async () => {
    try { await Location.requestForegroundPermissionsAsync(); } catch {}
    setStep("mic");
  };

  // ── Code validation ───────────────────────────────────────────────────────
  const VALID_CODES = ["herald2026", "miked2026"];
  const validateCode = () => {
    if (VALID_CODES.includes(accessCode.trim().toLowerCase())) {
      setCodeError("");
      setStep("name"); // user name before AI name (ainame)
    } else {
      setCodeError("That code isn't right. Try again.");
    }
  };

  const advanceFromName = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    saveLocalProfile("name", trimmedName);
    setStep("ainame");
  };

  // ── Final submit ──────────────────────────────────────────────────────────
  const handleFinish = async () => {
    const trimmedName   = name.trim() || "Friend";
    const trimmedAiName = aiName.trim() || "Herald";  // default to Herald if blank
    saveLocalProfile("ai_name", trimmedAiName);
    saveLocalProfile("persona", persona);
    setSubmitting(true);
    Speech.stop();
    try {
      const response = await fetch(`${API_BASE}/onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:        trimmedName,
          ai_name:     trimmedAiName,            // NEW: send chosen AI name
          persona:     persona,
          access_code: accessCode.trim().toLowerCase(),
          referral_code: accessCode.trim().toLowerCase() !== "herald2026" &&
                         accessCode.trim().toLowerCase() !== "miked2026"
                         ? accessCode.trim().toLowerCase()
                         : undefined,
        }),
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const data = await response.json();
      setUser(data.user_id, trimmedName);
      setPersona(persona);
      setOwner(data.is_owner);
      // Store the AI name -- used in header, greeting, everywhere
      if (storeSetAiName) storeSetAiName(data.ai_name || trimmedAiName);
      setOnboardingComplete();
      writeProfileFromOnboarding({
        userId: data.user_id,
        name:   trimmedName,
        aiName: trimmedAiName,
        persona: persona,
      });
    } catch {
      const fallbackId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setUser(fallbackId, trimmedName);
      setPersona(persona);
      setOwner(false);
      if (storeSetAiName) storeSetAiName(trimmedAiName);
      setOnboardingComplete();
      writeProfileFromOnboarding({
        userId: fallbackId,
        name:   trimmedName,
        aiName: trimmedAiName,
        persona: persona,
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (step === "code") {
    return (
      <BeachBg>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <View style={styles.centered}>
            <Text style={styles.stepCaption}>Step 1 of 7  ·  about 5 minutes</Text>
            <Text style={[styles.stepHeadline, { fontFamily: "SourceSerif4-Regular" }]}>
              Let's get you set up.
            </Text>
            <Text style={styles.stepBody}>
              I'll walk you through it one step at a time. Nothing here is permanent — you can change any of it later, or stop me whenever you like.
            </Text>
            <TextInput
              style={[styles.codeInput, codeError ? styles.inputError : null]}
              placeholder="Enter your invite code"
              placeholderTextColor="rgba(255,255,255,0.35)"
              value={accessCode}
              onChangeText={setAccessCode}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={validateCode}
            />
            {codeError ? <Text style={styles.errorText}>{codeError}</Text> : null}
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: "#4dd4d6" }]}
              onPress={validateCode}
              accessibilityRole="button"
            >
              <Text style={styles.primaryBtnText}>Begin</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </BeachBg>
    );
  }

  if (step === "name") {
    return (
      <BeachBg>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <View style={styles.centered}>
            <Text style={styles.stepCaption}>Step 2 of 7</Text>
            <Text style={[styles.stepHeadline, { fontFamily: "SourceSerif4-Regular" }]}>
              Who do I have the pleasure of meeting?
            </Text>
            <Text style={styles.stepBody}>
              Just your first name is perfect — it's how I'll greet you from now on.
            </Text>
            <TextInput
              style={styles.nameInput}
              placeholder="Type your name"
              placeholderTextColor="rgba(255,255,255,0.35)"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={advanceFromName}
            />
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: "#4dd4d6", opacity: name.trim() ? 1 : 0.5 }]}
              onPress={advanceFromName}
              disabled={!name.trim()}
              accessibilityRole="button"
            >
              <Text style={styles.primaryBtnText}>That's me</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </BeachBg>
    );
  }

  if (step === "ainame") {
    const firstName = name.trim() || "there";
    return (
      <BeachBg>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <View style={styles.centered}>
            <Text style={styles.stepGreeting}>Good to meet you, {firstName}.</Text>
            <Text style={[styles.stepHeadline, { fontFamily: "SourceSerif4-Regular" }]}>
              What would you like to call me?
            </Text>
            <Text style={styles.stepBody}>
              Pick a name that feels easy to say out loud. This is who you'll be talking to.
            </Text>
            <View style={styles.chipRow}>
              {["Sam", "Kit", "Cal", "Friday"].map((suggestion) => (
                <TouchableOpacity
                  key={suggestion}
                  style={[
                    styles.chip,
                    aiName === suggestion && { backgroundColor: "#4dd4d6", borderColor: "#4dd4d6" },
                  ]}
                  onPress={() => setAiName(suggestion)}
                >
                  <Text style={[
                    styles.chipText,
                    aiName === suggestion && { color: "#0d1217" },
                  ]}>{suggestion}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={styles.nameInput}
              placeholder="Or type something else…"
              placeholderTextColor="rgba(255,255,255,0.35)"
              value={aiName}
              onChangeText={setAiName}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => setStep("promise")}
            />
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: "#4dd4d6" }]}
              onPress={() => setStep("promise")}
              accessibilityRole="button"
            >
              <Text style={styles.primaryBtnText}>
                {aiName.trim() ? `Call you ${aiName.trim()}` : "Herald works for me"}
              </Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </BeachBg>
    );
  }

  if (step === "promise") {
    return (
      <BeachBg>
        <ScrollView contentContainerStyle={styles.centered} bounces={false}>
          <Text style={styles.stepCaption}>My promise to you</Text>
          <Text style={[styles.stepHeadline, { fontFamily: "SourceSerif4-Regular" }]}>
            Before anything else, here's the deal.
          </Text>
          <Text style={[styles.stepBody, { fontFamily: "SourceSerif4-Regular", marginBottom: 20 }]}>
            I'll never sell what I know about you. Not to anyone, not ever.{"\n\n"}
            I don't track where you go. There's no map of your day on some server.{"\n\n"}
            I only look when you ask — to find you a good meal, or get help if you're ever lost or in trouble.
          </Text>
          <Text style={[styles.stepBody, { fontSize: 15, marginBottom: 32 }]}>
            You're in charge of every bit of it. Turn anything off, anytime — and I'll still be here.
          </Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: "#4dd4d6" }]}
            onPress={() => setStep("notify")}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>Okay — I'm listening</Text>
          </TouchableOpacity>
        </ScrollView>
      </BeachBg>
    );
  }

  if (step === "notify") {
    return (
      <BeachBg>
        <View style={styles.centered}>
          <Text style={styles.stepCaption}>A quick ask  ·  Step 4 of 7</Text>
          <View style={styles.iconHalo}>
            <Text style={styles.iconGlyph}>🔔</Text>
          </View>
          <Text style={[styles.stepHeadline, { fontFamily: "SourceSerif4-Regular" }]}>
            Can I tap you on the shoulder?
          </Text>
          <Text style={styles.stepBody}>
            So I can let you know when something happens — a score you follow, a price you're watching, a friend's birthday coming up. You decide what's worth a tap, and you can turn it off anytime.
          </Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: "#4dd4d6" }]}
            onPress={() => setStep("location")}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>Yes, you can</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={() => setStep("location")}>
            <Text style={styles.ghostBtnText}>Not yet</Text>
          </TouchableOpacity>
        </View>
      </BeachBg>
    );
  }

  if (step === "location") {
    return (
      <BeachBg>
        <View style={styles.centered}>
          <Text style={styles.stepCaption}>A quick ask  ·  Step 5 of 7</Text>
          <View style={styles.iconHalo}>
            <Text style={styles.iconGlyph}>📍</Text>
          </View>
          <Text style={[styles.stepHeadline, { fontFamily: "SourceSerif4-Regular" }]}>
            Where are you?
          </Text>
          <Text style={styles.stepBody}>
            So I can tell you if it's raining outside, point you to a good place to eat nearby, or help if you're ever lost. I only check when you ask — never in the background, and I never share it with anyone.
          </Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: "#4dd4d6" }]}
            onPress={requestLocation}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>Sure, go ahead</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={() => setStep("mic")}>
            <Text style={styles.ghostBtnText}>Not yet</Text>
          </TouchableOpacity>
        </View>
      </BeachBg>
    );
  }

  if (step === "mic") {
    return (
      <BeachBg>
        <View style={styles.centered}>
          <Text style={styles.stepCaption}>One more  ·  Step 6 of 7</Text>
          <View style={styles.iconHalo}>
            <Text style={styles.iconGlyph}>🎤</Text>
          </View>
          <Text style={[styles.stepHeadline, { fontFamily: "SourceSerif4-Regular" }]}>
            Can I hear you?
          </Text>
          <Text style={styles.stepBody}>
            So you can just talk to me instead of typing. I only listen the moment you tap the mic — never in the background. I don't record or keep your voice.
          </Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: "#4dd4d6" }]}
            onPress={requestMic}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>Turn on talking</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={() => setStep("persona")}>
            <Text style={styles.ghostBtnText}>Not yet</Text>
          </TouchableOpacity>
        </View>
      </BeachBg>
    );
  }

  // ─── STEP 8: Persona ─────────────────────────────────────────────────────
  if (step === "persona") {
    const chosenAiName = aiName.trim() || "Herald";
    const handlePersonaSelect = (key: PersonaKey) => {
      Animated.spring(scaleAnims[key], { toValue: 1.01, useNativeDriver: true, friction: 8 }).start();
      PERSONA_KEYS.filter((k) => k !== key).forEach((k) =>
        Animated.spring(scaleAnims[k], { toValue: 1, useNativeDriver: true, friction: 8 }).start()
      );
      setPersonaKey(key);
    };
    return (
      <BeachBg>
        <ScrollView contentContainerStyle={styles.personaScroll} bounces={false}>
          <Text style={[styles.stepHeadline, { fontFamily: "SourceSerif4-Medium" }]}>
            Pick your look.
          </Text>
          <Text style={[styles.stepBody, { marginBottom: 24 }]}>
            {chosenAiName} takes its look from where{"\n"}
            you feel most at home.
          </Text>

          <View style={styles.tileGrid}>
            {PERSONA_KEYS.map((key) => {
              const p = PERSONAS[key];
              const selected = persona === key;
              return (
                <Animated.View key={key} style={{ transform: [{ scale: scaleAnims[key] }] }}>
                  <TouchableOpacity
                    style={[
                      styles.tile,
                      selected && {
                        borderColor: p.accent,
                        borderWidth: 2,
                        shadowColor: p.accent,
                        shadowOffset: { width: 0, height: 8 },
                        shadowOpacity: 0.55,
                        shadowRadius: 22,
                        elevation: 12,
                      },
                    ]}
                    onPress={() => handlePersonaSelect(key)}
                    activeOpacity={0.8}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                  >
                    <Image
                      source={PERSONA_IMAGES[key]}
                      style={styles.tileImage}
                      resizeMode="cover"
                    />
                    <LinearGradient
                      colors={["rgba(13,18,23,0.92)", "rgba(13,18,23,0.55)", "rgba(13,18,23,0.15)"]}
                      start={{ x: 0, y: 0.5 }}
                      end={{ x: 1, y: 0.5 }}
                      style={StyleSheet.absoluteFill}
                    />
                    <View style={[StyleSheet.absoluteFill, { backgroundColor: p.surfaceTint }]} />
                    <View style={styles.tileLabelRow}>
                      <Text style={styles.tileName}>{p.name}</Text>
                      <Text style={styles.tileTagline}>{p.tagline}</Text>
                      <View style={{ flexDirection: "row", gap: 5, marginTop: 6 }}>
                        {p.palette.map((color, i) => (
                          <View
                            key={i}
                            style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }}
                          />
                        ))}
                      </View>
                    </View>
                    {selected && (
                      <View style={[styles.tileCheck, { backgroundColor: p.accent }]}>
                        <Text style={[styles.tileCheckMark, { color: "#0d1217" }]}>✓</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                </Animated.View>
              );
            })}
          </View>

          <TouchableOpacity
            style={[
              styles.bigBtn,
              {
                backgroundColor: "#2dd4bf",
                opacity: isSubmitting ? 0.7 : 1,
                marginTop: 8,
                marginHorizontal: 0,
              },
            ]}
            onPress={() => setStep("confirm")}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={[styles.bigBtnText, { color: "#0a1f1a", fontFamily: "Inter-Bold" }]}>
                Continue
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </BeachBg>
    );
  }

  if (step === "confirm") {
    return (
      <PersonaConfirmScreen
        personaKey={persona}
        aiName={aiName.trim() || "Herald"}
        onComplete={handleFinish}
      />
    );
  }

  return null;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex:      { flex: 1 },
  container: { flex: 1 },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical:   48,
  },
  personaScroll: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 40,
  },

  logoBox: {
    width: 80, height: 80, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
    marginBottom: 20,
  },
  logoLetter: {
    fontSize: 44, fontWeight: "800", color: "#FFFFFF", letterSpacing: -1,
  },
  wordmark: {
    fontSize: 30, fontWeight: "800", color: "#E8F4F8",
    letterSpacing: 6, marginBottom: 8,
  },
  tagline: {
    fontSize: 15, color: "#6A8A9A", textAlign: "center", lineHeight: 22,
  },

  emoji: {
    fontSize: 56, textAlign: "center", marginBottom: 24,
  },
  stepHeadline: {
    fontSize: 26, fontWeight: "700", color: "#E8F4F8",
    textAlign: "center", marginBottom: 16, lineHeight: 34,
  },
  stepBody: {
    fontSize: 17, color: "#8AAABB", textAlign: "center",
    lineHeight: 28, marginBottom: 40,
  },
  bodyText: {
    fontSize: 16, color: "#6A8A9A", textAlign: "center",
    lineHeight: 26, marginTop: 24, marginBottom: 48,
  },

  codeInput: {
    width: "100%", fontSize: 18, color: "#E8F4F8",
    paddingVertical: 16, paddingHorizontal: 20,
    backgroundColor: "#0F2040", borderRadius: 12,
    borderWidth: 1, borderColor: "#1E3A5A",
    marginTop: 32, marginBottom: 8,
    textAlign: "center", letterSpacing: 1,
  },
  nameInput: {
    width: "100%", fontSize: 22, fontWeight: "500", color: "#E8F4F8",
    paddingVertical: 18, paddingHorizontal: 20,
    backgroundColor: "#0F2040", borderRadius: 12,
    borderWidth: 1, borderColor: "#1E3A5A",
    marginTop: 8, marginBottom: 16, textAlign: "center",
  },
  inputError: { borderColor: "#E07B39" },
  errorText: {
    color: "#E07B39", fontSize: 13, textAlign: "center", marginBottom: 8,
  },

  bigBtn: {
    width: "100%", paddingVertical: 20, borderRadius: 14,
    alignItems: "center", marginTop: 8,
  },
  bigBtnText: {
    color: "#FFFFFF", fontSize: 18, fontWeight: "700", letterSpacing: 0.3,
  },
  skipBtn: { paddingVertical: 16, alignItems: "center" },
  skipText: { fontSize: 14, color: "#3A5A6A", textDecorationLine: "underline" },

  tileGrid: { gap: 12 },
  tile: {
    width: "100%", height: 130, borderRadius: 18,
    overflow: "hidden", borderWidth: 0, borderColor: "transparent",
    marginBottom: 4,
  },
  tileImage: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    width: "100%", height: "100%",
  },
  tileOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  tileLabelRow: {
    position: "absolute", bottom: 14, left: 16,
  },
  tileName: {
    fontSize: 20, fontWeight: "700", color: "#FFFFFF", letterSpacing: -0.2,
    fontFamily: "SourceSerif4-Medium",
  },
  tileTagline: {
    fontSize: 13, color: "rgba(255,255,255,0.75)", marginTop: 2,
  },
  tileCheck: {
    position: "absolute", top: 12, right: 12,
    width: 28, height: 28, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
  },
  tileCheckMark: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },

  stepCaption: {
    fontFamily: "Inter-Medium",
    fontSize: 11,
    letterSpacing: 0.18 * 11,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.55)",
    marginBottom: 20,
    textAlign: "center",
  },
  stepGreeting: {
    fontFamily: "Inter-Medium",
    fontSize: 15,
    color: "rgba(255,255,255,0.72)",
    marginBottom: 8,
    textAlign: "center",
  },
  primaryBtn: {
    width: "100%",
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  primaryBtnText: {
    fontFamily: "Inter-Bold",
    fontSize: 17,
    color: "#0d1217",
  },
  ghostBtn: {
    width: "100%",
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  ghostBtnText: {
    fontFamily: "Inter-Medium",
    fontSize: 15,
    color: "rgba(255,255,255,0.72)",
  },
  iconHalo: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(77,212,214,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  iconGlyph: {
    fontSize: 36,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "center",
    marginBottom: 16,
    marginTop: 8,
  },
  chip: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.22)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  chipText: {
    fontFamily: "Inter-Medium",
    fontSize: 15,
    color: "rgba(255,255,255,0.85)",
  },
});
