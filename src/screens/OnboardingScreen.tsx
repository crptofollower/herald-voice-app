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
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import { Audio } from "expo-av";
import { PERSONAS, type PersonaKey } from "../constants/personas";
import { useStore } from "../store/useStore";
import { API_BASE } from "../constants/api";
import { saveLocalProfile } from "../hooks/useDeviceMemory";

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = "intro" | "mic" | "location" | "notify" | "code" | "name" | "ainame" | "persona";

const PERSONA_KEYS = Object.keys(PERSONAS) as PersonaKey[];

const BG_TOP    = "#0A1628";
const BG_BOTTOM = "#0D2440";
const ACCENT    = "#1A9B8A";

const PERSONA_IMAGES: Record<PersonaKey, ReturnType<typeof require>> = {
  beach:    require("../../assets/beach.jpg"),
  mountain: require("../../assets/mountain.jpg"),
  city:     require("../../assets/city.jpg"),
  country:  require("../../assets/country.jpg"),
  desert:   require("../../assets/desert.jpg"),
};

const HERALD_SPEECH: Record<string, string> = {
  intro:    "Hi. I am Herald. Your personal AI. Always on, always ready. Let me get you set up. It will only take a minute.",
  mic:      "Can I hear you? I will listen when you tap the mic. I never record in the background. Never.",
  location: "Can I see where you are? I will know your weather and what is nearby. I only check when you ask.",
  notify:   "Can I tap you on the shoulder? I will let you know when something you care about happens. A score, a price, something you are watching. You can turn this off anytime.",
  code:     "Enter your access code to get started.",
  name:     "What should I call you?",
  ainame:   "And what would you like to call me? Herald is my default. But make me yours.",
  persona:  "Pick the world that feels most like you.",
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
  const [step, setStep]               = useState<Step>("intro");
  const [accessCode, setAccessCode]   = useState("");
  const [codeError, setCodeError]     = useState("");
  const [name, setName]               = useState("");
  const [aiName, setAiName]           = useState("");          // NEW: what user calls Herald
  const [persona, setPersonaKey]      = useState<PersonaKey>("city");
  const [isSubmitting, setSubmitting] = useState(false);

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

  const DarkBg = ({ children }: { children: React.ReactNode }) => (
    <LinearGradient colors={[BG_TOP, BG_BOTTOM]} style={styles.container}>
      <FadeIn>{children}</FadeIn>
    </LinearGradient>
  );

  // ── Permission helpers ────────────────────────────────────────────────────
  const requestMic = async () => {
    try { await Audio.requestPermissionsAsync(); } catch {}
    setStep("location");
  };

  const requestLocation = async () => {
    try { await Location.requestForegroundPermissionsAsync(); } catch {}
    setStep("notify");
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
    } catch {
      const fallbackId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setUser(fallbackId, trimmedName);
      setPersona(persona);
      setOwner(false);
      if (storeSetAiName) storeSetAiName(trimmedAiName);
      setOnboardingComplete();
    } finally {
      setSubmitting(false);
    }
  };

  // ─── STEP 1: Intro ────────────────────────────────────────────────────────
  if (step === "intro") {
    return (
      <DarkBg>
        <View style={styles.centered}>
          <View style={[styles.logoBox, { backgroundColor: ACCENT }]}>
            <Text style={styles.logoLetter}>H</Text>
          </View>
          <Text style={styles.wordmark}>HERALD</Text>
          <Text style={styles.tagline}>Your personal AI.</Text>
          <Text style={styles.tagline}>Always on. Always ready.</Text>
          <Text style={styles.bodyText}>
            I'm going to ask you a few quick things.{"\n"}
            It'll take less than a minute.
          </Text>
          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: ACCENT }]}
            onPress={() => setStep("mic")}
            accessibilityRole="button"
          >
            <Text style={styles.bigBtnText}>Let's go →</Text>
          </TouchableOpacity>
        </View>
      </DarkBg>
    );
  }

  // ─── STEP 2: Mic ─────────────────────────────────────────────────────────
  if (step === "mic") {
    return (
      <DarkBg>
        <View style={styles.centered}>
          <Text style={styles.emoji}>🎤</Text>
          <Text style={styles.stepHeadline}>Can I hear you?</Text>
          <Text style={styles.stepBody}>
            Talk to me instead of typing.{"\n"}
            I only listen when you tap the mic.{"\n"}
            Never in the background.
          </Text>
          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: ACCENT }]}
            onPress={requestMic}
          >
            <Text style={styles.bigBtnText}>Yes, let's go</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={() => setStep("location")}>
            <Text style={styles.skipText}>skip</Text>
          </TouchableOpacity>
        </View>
      </DarkBg>
    );
  }

  // ─── STEP 3: Location ────────────────────────────────────────────────────
  if (step === "location") {
    return (
      <DarkBg>
        <View style={styles.centered}>
          <Text style={styles.emoji}>📍</Text>
          <Text style={styles.stepHeadline}>Can I see where you are?</Text>
          <Text style={styles.stepBody}>
            I'll know your weather and what's nearby.{"\n"}
            I only check when you ask.{"\n"}
            Never tracking in the background.
          </Text>
          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: ACCENT }]}
            onPress={requestLocation}
          >
            <Text style={styles.bigBtnText}>Sure</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={() => setStep("notify")}>
            <Text style={styles.skipText}>skip</Text>
          </TouchableOpacity>
        </View>
      </DarkBg>
    );
  }

  // ─── STEP 4: Notifications ───────────────────────────────────────────────
  if (step === "notify") {
    return (
      <DarkBg>
        <View style={styles.centered}>
          <Text style={styles.emoji}>🔔</Text>
          <Text style={styles.stepHeadline}>Can I tap you on the shoulder?</Text>
          <Text style={styles.stepBody}>
            I'll let you know when something{"\n"}
            you care about happens.{"\n"}
            A score. A price. Something you're watching.{"\n"}
            You can turn this off anytime.
          </Text>
          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: ACCENT }]}
            onPress={() => setStep("code")}
          >
            <Text style={styles.bigBtnText}>Sure</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={() => setStep("code")}>
            <Text style={styles.skipText}>skip</Text>
          </TouchableOpacity>
        </View>
      </DarkBg>
    );
  }

  // ─── STEP 5: Access code ─────────────────────────────────────────────────
  if (step === "code") {
    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <LinearGradient colors={[BG_TOP, BG_BOTTOM]} style={styles.container}>
          <View style={styles.centered}>
            <View style={[styles.logoBox, { backgroundColor: ACCENT }]}>
              <Text style={styles.logoLetter}>H</Text>
            </View>
            <Text style={styles.wordmark}>HERALD</Text>
            <Text style={styles.tagline}>Your personal AI — always on, always ready.</Text>
            <TextInput
              style={[styles.codeInput, codeError ? styles.inputError : null]}
              placeholder="Enter your access code..."
              placeholderTextColor="#4A6A7A"
              value={accessCode}
              onChangeText={(t) => { setAccessCode(t); setCodeError(""); }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={validateCode}
            />
            {codeError ? <Text style={styles.errorText}>{codeError}</Text> : null}
            <TouchableOpacity
              style={[styles.bigBtn, { backgroundColor: ACCENT, opacity: accessCode.trim() ? 1 : 0.5 }]}
              onPress={validateCode}
              disabled={!accessCode.trim()}
            >
              <Text style={styles.bigBtnText}>GET STARTED</Text>
            </TouchableOpacity>
          </View>
        </LinearGradient>
      </KeyboardAvoidingView>
    );
  }

  // ─── STEP 6: User name ───────────────────────────────────────────────────
  if (step === "name") {
    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <LinearGradient colors={[BG_TOP, BG_BOTTOM]} style={styles.container}>
          <View style={styles.centered}>
            <Text style={styles.stepHeadline}>What should I call you?</Text>
            <Text style={styles.stepBody}>
              I'll remember this.{"\n"}
              Use whatever you actually go by.
            </Text>
            <TextInput
              style={styles.nameInput}
              placeholder="Your name"
              placeholderTextColor="#4A6A7A"
              value={name}
              onChangeText={setName}
              autoFocus
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={advanceFromName}
            />
            <TouchableOpacity
              style={[styles.bigBtn, { backgroundColor: ACCENT, opacity: name.trim() ? 1 : 0.5 }]}
              onPress={advanceFromName}
              disabled={!name.trim()}
            >
              <Text style={styles.bigBtnText}>That's me →</Text>
            </TouchableOpacity>
          </View>
        </LinearGradient>
      </KeyboardAvoidingView>
    );
  }

  // ─── STEP 7: AI name (NEW) ────────────────────────────────────────────────
  // This is the hook. The user names their AI. It becomes theirs.
  // Mickey named his "Harry." That's what makes this a companion, not a tool.
  if (step === "ainame") {
    const displayName = name.trim() || "Friend";
    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <LinearGradient colors={[BG_TOP, BG_BOTTOM]} style={styles.container}>
          <View style={styles.centered}>
            <Text style={styles.stepHeadline}>
              Nice to meet you, {displayName}.
            </Text>
            <Text style={styles.stepBody}>
              What would you like to call me?{"\n"}
              Herald is my default — but make me yours.
            </Text>
            <TextInput
              style={styles.nameInput}
              placeholder="Herald"
              placeholderTextColor="#4A6A7A"
              value={aiName}
              onChangeText={setAiName}
              autoFocus
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => setStep("persona")}
            />
            <TouchableOpacity
              style={[styles.bigBtn, { backgroundColor: ACCENT }]}
              onPress={() => setStep("persona")}
            >
              <Text style={styles.bigBtnText}>
                {aiName.trim()
                  ? `Got it, I'm ${aiName.trim()} →`
                  : "Herald works for me →"}
              </Text>
            </TouchableOpacity>
          </View>
        </LinearGradient>
      </KeyboardAvoidingView>
    );
  }

  // ─── STEP 8: Persona ─────────────────────────────────────────────────────
  if (step === "persona") {
    const chosenAiName = aiName.trim() || "Herald";
    return (
      <LinearGradient colors={[BG_TOP, BG_BOTTOM]} style={styles.container}>
        <ScrollView contentContainerStyle={styles.personaScroll} bounces={false}>
          <Text style={styles.stepHeadline}>Pick your world.</Text>
          <Text style={[styles.stepBody, { marginBottom: 24 }]}>
            {chosenAiName} takes its look from where{"\n"}
            you feel most at home.
          </Text>

          <View style={styles.tileGrid}>
            {PERSONA_KEYS.map((key) => {
              const p = PERSONAS[key];
              const selected = persona === key;
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.tile,
                    selected && { borderColor: p.colors.accent, borderWidth: 3 },
                  ]}
                  onPress={() => setPersonaKey(key)}
                  activeOpacity={0.8}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                >
                  <Image
                    source={PERSONA_IMAGES[key]}
                    style={styles.tileImage}
                    resizeMode="cover"
                  />
                  <View style={styles.tileOverlay} />
                  <View style={styles.tileLabelRow}>
                    <Text style={styles.tileName}>{p.name}</Text>
                    <Text style={styles.tileTagline}>{p.tagline}</Text>
                  </View>
                  {selected && (
                    <View style={[styles.tileCheck, { backgroundColor: p.colors.accent }]}>
                      <Text style={styles.tileCheckMark}>✓</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={[
              styles.bigBtn,
              {
                backgroundColor: PERSONAS[persona].colors.accent,
                opacity: isSubmitting ? 0.7 : 1,
                marginTop: 8,
                marginHorizontal: 0,
              },
            ]}
            onPress={handleFinish}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.bigBtnText}>
                {name.trim() ? `Let's go, ${name.trim()} →` : "Let's go →"}
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </LinearGradient>
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
    width: "100%", height: 110, borderRadius: 16,
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
  },
  tileTagline: {
    fontSize: 13, color: "rgba(255,255,255,0.75)", marginTop: 2,
  },
  tileCheck: {
    position: "absolute", top: 12, right: 12,
    width: 26, height: 26, borderRadius: 13,
    alignItems: "center", justifyContent: "center",
  },
  tileCheckMark: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
});
