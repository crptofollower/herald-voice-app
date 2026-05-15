import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ScrollView, Platform,
  KeyboardAvoidingView, ActivityIndicator,
} from "react-native";
import * as Crypto from "expo-crypto";
import { PERSONAS, type PersonaKey } from "../constants/personas";
import { useStore } from "../store/useStore";
import { createProfile } from "../api/herald";
import { OWNER_AUTH_CODE, BETA_ACCESS_CODE } from "../constants/api";

const PERSONA_KEYS = Object.keys(PERSONAS) as PersonaKey[];

export default function OnboardingScreen() {
  const [name, setName]                   = useState("");
  const [selectedPersona, setSelectedPersona] = useState<PersonaKey>("city");
  const [step, setStep]                   = useState<"name" | "persona">("name");
  const [isSaving, setIsSaving]           = useState(false);
  const { setUser, setPersona, setOnboardingComplete, setOwner } = useStore();

  const handleFinish = async () => {
    if (isSaving) return;
    const trimmed  = name.trim() || "Friend";
    const userId   = Crypto.randomUUID();
    const isOwner  = !!OWNER_AUTH_CODE && trimmed.toLowerCase() === "miked";
    setUser(userId, trimmed);
    setPersona(selectedPersona);
    if (isOwner) setOwner(true);
    setIsSaving(true);
    try {
      await createProfile({
        user_id:    userId,
        name:       trimmed,
        persona:    selectedPersona,
        access_code: BETA_ACCESS_CODE,
        owner_code: isOwner ? OWNER_AUTH_CODE : undefined,
      });
    } catch (err) {
      console.warn("[Herald] Profile creation failed:", err);
    } finally {
      setIsSaving(false);
    }
    setOnboardingComplete();
  };

  if (step === "name") {
    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.container, { backgroundColor: "#FBF9F7" }]}>
          <View style={styles.inner}>
            <Text style={styles.wordmark}>Herald</Text>
            <Text style={styles.headline}>What should I call you?</Text>
            <Text style={styles.sub}>I'll remember this. You can change it anytime.</Text>
            <TextInput
              style={styles.input}
              placeholder="Your name"
              placeholderTextColor="#9A8878"
              value={name}
              onChangeText={setName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => name.trim() && setStep("persona")}
              autoCapitalize="words"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[styles.btn, { opacity: name.trim() ? 1 : 0.4 }]}
              onPress={() => name.trim() && setStep("persona")}
              disabled={!name.trim()}
            >
              <Text style={styles.btnText}>Next</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  const currentPersona = PERSONAS[selectedPersona];

  return (
    <View style={[styles.container, { backgroundColor: currentPersona.colors.background }]}>
      <ScrollView contentContainerStyle={styles.inner} bounces={false}>
        <Text style={[styles.wordmark, { color: currentPersona.colors.text }]}>Herald</Text>
        <Text style={[styles.headline, { color: currentPersona.colors.text }]}>Pick your environment</Text>
        <Text style={[styles.sub, { color: currentPersona.colors.textMuted }]}>
          Herald takes its colors from where you feel most at home.
        </Text>

        {PERSONA_KEYS.map((key) => {
          const p        = PERSONAS[key];
          const selected = selectedPersona === key;
          return (
            <TouchableOpacity
              key={key}
              style={[styles.personaRow, {
                backgroundColor: p.colors.surface,
                borderColor:     selected ? p.colors.accent : p.colors.border,
                borderWidth:     selected ? 2 : 1,
              }]}
              onPress={() => setSelectedPersona(key)}
            >
              <View style={[styles.personaDot, { backgroundColor: p.colors.accent }]} />
              <View style={styles.personaText}>
                <Text style={[styles.personaLabel,   { color: p.colors.text }]}>{p.name}</Text>
                <Text style={[styles.personaTagline, { color: p.colors.textMuted }]}>{p.greeting}</Text>
              </View>
              {selected && (
                <View style={[styles.checkCircle, { backgroundColor: p.colors.accent }]}>
                  <Text style={styles.checkMark}>✓</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: currentPersona.colors.accent, opacity: isSaving ? 0.7 : 1 }]}
          onPress={handleFinish}
          disabled={isSaving}
        >
          {isSaving
            ? <ActivityIndicator color="#FFFFFF" />
            : <Text style={styles.btnText}>Let's go, {name.trim()}</Text>
          }
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex:      { flex: 1 },
  container: { flex: 1 },
  inner:     { flexGrow: 1, paddingHorizontal: 28, paddingTop: 80, paddingBottom: 48 },
  wordmark:  { fontSize: 22, fontWeight: "700", marginBottom: 32, letterSpacing: -0.3 },
  headline:  { fontSize: 30, fontWeight: "700", lineHeight: 38, marginBottom: 12, letterSpacing: -0.5 },
  sub:       { fontSize: 16, lineHeight: 24, marginBottom: 36 },
  input:     { fontSize: 20, fontWeight: "500", color: "#1A1714", paddingVertical: 16, paddingHorizontal: 20, backgroundColor: "#FFFFFF", borderRadius: 14, borderWidth: 1, borderColor: "#E8DDD2", marginBottom: 16 },
  btn:       { paddingVertical: 18, borderRadius: 14, alignItems: "center", marginTop: 8 },
  btnText:   { color: "#FFFFFF", fontSize: 17, fontWeight: "600" },
  personaRow:     { flexDirection: "row", alignItems: "center", paddingVertical: 18, paddingHorizontal: 18, borderRadius: 14, marginBottom: 10 },
  personaDot:     { width: 12, height: 12, borderRadius: 6, marginRight: 16 },
  personaText:    { flex: 1 },
  personaLabel:   { fontSize: 17, fontWeight: "600", marginBottom: 2 },
  personaTagline: { fontSize: 14, lineHeight: 20 },
  checkCircle:    { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  checkMark:      { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
});