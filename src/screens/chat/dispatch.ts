// src/screens/chat/dispatch.ts
//
// Dispatch layer for Herald's send path. Extracted from ChatScreen.tsx so the
// per-intent read/action handlers live in one testable module instead of inside
// a 3700-line component. Handlers receive their dependencies explicitly via
// DispatchDeps — no component-scope closure capture, no temporal-dead-zone hazard.
//
// Stage 1.2: skeleton only. Signatures defined, bodies not yet moved. Nothing
// imports this file yet. Subsequent stages (1.3 reads, 1.4 actions) fill the bodies.

import type { MutableRefObject } from 'react';
import type { LlamaContext } from 'llama.rn';
import type { Message } from '../../api/herald';
import type { TierDecision } from '../../routing/tierRouter';
import { phraseWithLLM } from '../../hooks/llmLayers';
import { Platform, Linking } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDB } from '../../db/schema';
import { answerHouseholdRead } from '../../utils/householdRead';
import { guessMedicationName, deactivateMedicationByName, getActiveMedications } from '../../db/medicalDB';
import { isMedicationCorroborated } from '../../db/factDB';

// Pending-confirmation refs the dispatch handlers set so the NEXT user turn can
// resolve them (collect a phone number, confirm a medication, etc.).
export interface DispatchPendingRefs {
  pendingContactCollectRef: MutableRefObject<{ action: 'call' | 'navigate' | 'text' | 'confirm_phone'; name: string; body?: string } | null>;
  pendingMedConfirmRef: MutableRefObject<{ category: 'medication' | 'medical' | 'visit'; value: string; guessedName: string; guessedDosage?: string } | null>;
  pendingMedClearRef: MutableRefObject<{ count: number } | null>;
  pendingTodoCompleteRef: MutableRefObject<{ id: string; body: string } | null>;
}

// Everything the dispatch handlers need from the component, passed explicitly.
export interface DispatchDeps extends DispatchPendingRefs {
  addMessage: (m: Message) => void;
  speak: (text: string, opts?: { rate?: number }) => void;
  setInputText: (s: string) => void;
  sendingRef: MutableRefObject<boolean>;
  generateId: (prefix: string) => string;
  llmStatus: string;
  getCtx: () => LlamaContext | null;
  inferLocal: (prompt: string, maxTokens: number) => Promise<string | null>;
  phraseWithLLM: typeof phraseWithLLM;
  resolveContactPhone: (nameOrRelation: string) => Promise<{ phone: string; name: string; contactId?: string } | null>;
  handleCalendarAction: (value: string) => Promise<void>;
  handleMapsAction: (query: string) => Promise<void>;
  launchAndroidTimer: (seconds: number) => Promise<boolean>;
  handleLaunchActionRef: MutableRefObject<((appName: string) => Promise<void>) | null>;
}

// Tier-1 READ dispatch (calendar/medical/family/profile). Filled in Stage 1.3.
// isMedical reads are spoken verbatim — NEVER wrapped by the LLM (CLAUDE.md).
export async function dispatchRead(
  response: string,
  llmWrap: boolean,
  isMedical: boolean,
  text: string,
  deps: DispatchDeps,
): Promise<void> {
  const { addMessage, speak, generateId, inferLocal } = deps;
  // User bubble — added once, here, for the routed read.
  addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });

  let finalResponse = response;
  // Medical reads are NEVER LLM-wrapped (CLAUDE.md). Wrap only non-medical reads,
  // and only when the router asked for it.
  if (llmWrap && !isMedical) {
    const wrapped = await inferLocal(
      `You are Herald. Report ONLY the following confirmed data in one warm sentence. Do NOT add medical explanations, drug descriptions, or any information not in the data. Do NOT refuse. Just say what's there.\nData: "${response}"\nUser asked: "${text}"`,
      60
    );
    if (wrapped) finalResponse = wrapped;
  }

  addMessage({ id: generateId('msg'), role: 'assistant', content: finalResponse, timestamp: Date.now() });
  speak(finalResponse);
}

// Tier-1 ACTION dispatch (alarm/timer/sms/calendar/medical/call/nav/reminder/
// note/list/todo/...). Filled in Stage 1.4.
export async function dispatchAction(
  actionIntent: NonNullable<TierDecision['actionIntent']>,
  text: string,
  deps: DispatchDeps,
): Promise<void> {
  const {
    addMessage, speak, generateId, llmStatus, getCtx, phraseWithLLM,
    resolveContactPhone, handleCalendarAction, handleMapsAction, launchAndroidTimer,
    handleLaunchActionRef, pendingContactCollectRef, pendingMedConfirmRef,
    pendingMedClearRef, pendingTodoCompleteRef,
  } = deps;

  // === arms copied from ChatScreen.tsx below ===
        if (actionIntent.type === 'alarm') {
          const { time, label } = actionIntent;
          const [h, m] = time.split(':');
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          let alarmOpened = false;
          if (Platform.OS === 'android') {
            try {
              await IntentLauncher.startActivityAsync('android.intent.action.SET_ALARM', {
                extra: {
                  'android.intent.extra.alarm.HOUR': parseInt(h, 10),
                  'android.intent.extra.alarm.MINUTES': parseInt(m, 10),
                  'android.intent.extra.alarm.MESSAGE': label,
                  'android.intent.extra.alarm.SKIP_UI': true,
                },
              });
              alarmOpened = true;
            } catch {
              try {
                await IntentLauncher.startActivityAsync('android.intent.action.SET_ALARM', {
                  extra: {
                    'android.intent.extra.alarm.HOUR': parseInt(h, 10),
                    'android.intent.extra.alarm.MINUTES': parseInt(m, 10),
                    'android.intent.extra.alarm.MESSAGE': label,
                    'android.intent.extra.alarm.SKIP_UI': true,
                  },
                  packageName: 'com.sec.android.app.clockpackage',
                });
                alarmOpened = true;
              } catch {}
            }
          }
          const alarmDate = new Date();
          alarmDate.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
          const spoken = alarmDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          const reply = alarmOpened
            ? `Alarm set for ${spoken}.`
            : `I couldn't open the clock app. Open it manually and set an alarm for ${spoken}.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }
        if (actionIntent.type === 'timer') {
          const { minutes } = actionIntent;
          const hours = Math.floor(minutes / 60);
          const mins = minutes % 60;
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const timerOpened = Platform.OS === 'android'
            ? await launchAndroidTimer(minutes * 60)
            : false;
          const label = minutes >= 60
            ? `${hours > 0 ? hours + ' hour' + (hours > 1 ? 's' : '') : ''}${mins > 0 ? ' ' + mins + ' minute' + (mins > 1 ? 's' : '') : ''}`
            : `${minutes} minute${minutes > 1 ? 's' : ''}`;
          const reply = timerOpened
            ? `Timer set for ${label.trim()}.`
            : `I couldn't open the clock app. Open it manually and set a timer for ${label.trim()}.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }
        if (actionIntent.type === 'sms') {
          const { contact, message } = actionIntent;
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          // Try to resolve contact number first
          const resolvedSms = await resolveContactPhone(contact);
          if (resolvedSms?.phone) {
            const smsUrl = `sms:${resolvedSms.phone.replace(/\D/g, '')}${message ? `?body=${encodeURIComponent(message)}` : ''}`;
            await Linking.openURL(smsUrl);
            const reply = message
              ? `Opening a message to ${resolvedSms.name} with your note ready.`
              : `Opening a message to ${resolvedSms.name}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } else {
            const reply = `I don't have a number for ${contact}. What's their number?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            pendingContactCollectRef.current = { action: 'text', name: contact, body: message };
          }
          return;
        }
        if (actionIntent.type === 'calendar_write') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          await handleCalendarAction(actionIntent.value);
          return;
        }
        if (actionIntent.type === 'medical_capture') {
          const medEvent = actionIntent.event;
          // MEDICATION: always confirm before writing. A dosage or corroboration
          // signal only changes how confident the question SOUNDS — never whether
          // we ask. Free-text drug-name guessing is correction-prone (Spine §4,
          // Jun-20 decision: no corroboration exception).
          if (medEvent.type === 'medication') {
            const guessedName = medEvent.drug_name ?? guessMedicationName(medEvent.raw);
            addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
            if (!guessedName || guessedName.trim().length < 2) {
              const ask = 'What medication is that?';
              addMessage({ id: generateId('msg'), role: 'assistant', content: ask, timestamp: Date.now() });
              speak(ask);
              return;
            }
            const guessedDosage = medEvent.dosage ?? undefined;
            pendingMedConfirmRef.current = { category: 'medication', value: medEvent.raw, guessedName, guessedDosage };
            const reply = isMedicationCorroborated(medEvent.raw)
              ? (guessedDosage
                  ? `Got it — ${guessedName}, ${guessedDosage}. Sound right?`
                  : `Got it — ${guessedName}. Sound right?`)
              : `Want me to remember ${guessedName} as a medication?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            return;
          }
          const { captureMedicalEvent } = await import('../../utils/captureMedicalEvent');
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const result = captureMedicalEvent(medEvent);
            const reply = result.followUpQuestion ?? "Got it — I'll remember that.";
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = "I couldn't save that — could you try again?";
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }
        if (actionIntent.type === 'medical_remove') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const removeName = actionIntent.name;
          let changed = 0;
          try { changed = deactivateMedicationByName(removeName); } catch {}
          const reply = changed > 0
            ? `Done — took ${removeName} off your current medications.`
            : `I don't have ${removeName} in your current medications.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }
        if (actionIntent.type === 'medical_clear') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          let count = 0;
          try { count = getActiveMedications().length; } catch {}
          if (count === 0) {
            const reply = `You don't have any medications saved right now.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            return;
          }
          pendingMedClearRef.current = { count };
          const reply = `This will remove all ${count} of your medications. Are you sure?`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }
        if (actionIntent.type === 'household_read') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const deterministicReply = answerHouseholdRead(actionIntent.intent);
          let reply = deterministicReply;
          if (llmStatus === 'ready' && !deterministicReply.startsWith("I don't have")) {
            const ctx = getCtx();
            const phrased = await phraseWithLLM(ctx, {
              userQuestion: text,
              confirmedData: deterministicReply,
              isMedical: false,
            });
            if (phrased) reply = phrased;
          }
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }
        if (actionIntent.type === 'photo_open') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          let opened = false;
          if (Platform.OS === 'android') {
            const photoIntents = [
              'intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.google.android.apps.photos;end',
              'intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.sec.android.gallery3d;end',
              'googlephotos://',
            ];
            for (const uri of photoIntents) {
              try {
                await Linking.openURL(uri);
                opened = true;
                break;
              } catch { /* try next */ }
            }
          }
          const reply = opened
            ? 'Opening your photos.'
            : "I couldn't open your gallery — try opening Photos manually.";
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }

        if (actionIntent.type === 'app_open') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const { appName } = actionIntent;
          let opened = false;
          try {
            if (appName.toLowerCase().includes('camera') || /\bselfie\b/i.test(text)) {
              await IntentLauncher.startActivityAsync('android.media.action.IMAGE_CAPTURE', {});
              opened = true;
            } else {
              await handleLaunchActionRef.current?.(appName);
              opened = true;
            }
          } catch { /* fall through */ }
          const reply = opened
            ? `Opening ${appName}.`
            : `I couldn't open ${appName} — try opening it manually.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }

        // Time — pure device clock
        if (actionIntent.type === 'time') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          const reply = `It's ${t}.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }

        // Date — pure device clock
        if (actionIntent.type === 'date') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const d = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
          const reply = `It's ${d}.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }

        // Call — resolve contact on device, fire tel: intent
        if (actionIntent.type === 'call') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const contactName = actionIntent.contact;
          const resolved = await resolveContactPhone(contactName);
          if (resolved?.phone) {
            await Linking.openURL(`tel:${resolved.phone.replace(/\D/g, '')}`);
            const reply = `Calling ${resolved.name}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } else {
            // No number — ask to collect it, then call immediately after
            const reply = `I don't have a number for ${contactName}. What's their number?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            // Store pending call so next message resolves it
            pendingContactCollectRef.current = { action: 'call', name: contactName };
          }
          return;
        }

        // Navigation — resolve contact/address on device, fire maps intent (zero-tap)
        if (actionIntent.type === 'navigation') {
          const { findContactByRelationship, findContactByName } = await import('../../db/contactsDB');
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const raw = actionIntent.destination;

          const cleaned = raw
            .replace(/^(my\s+|the\s+|our\s+)/i, '')
            .replace(/'s\s*$/i, '')
            .trim();

          const contact = findContactByRelationship(cleaned) ?? findContactByName(cleaned);

          if (contact?.address) {
            await handleMapsAction(contact.address);
            const reply = `Opening directions to ${contact.name}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } else if (contact) {
            const reply = `I know ${contact.name} but I don't have an address for them. What's their address?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            pendingContactCollectRef.current = { action: 'navigate', name: contact.name };
          } else {
            await handleMapsAction(raw);
            const reply = `Opening directions to ${raw}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        if (actionIntent.type === 'reminder') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const Notifications = await import('expo-notifications');
            const { status } = await Notifications.requestPermissionsAsync();
            if (status !== 'granted') {
              const reply = `I need notification permission to set reminders. Check your settings and try again.`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
              return;
            }
            const [h, m] = actionIntent.time.split(':').map(Number);
            const trigger = new Date();
            trigger.setHours(h, m, 0, 0);
            if (trigger <= new Date()) trigger.setDate(trigger.getDate() + 1);

            // Write to SQLite FIRST — if this fails, don't schedule
            const { getDB } = await import('../../db/schema');
            const db = getDB();
            const remId = `rem_${Date.now()}`;
            db.runSync(
              `INSERT INTO reminders (id, body, remind_at, fired, created_at) VALUES (?, ?, ?, 0, ?);`,
              [remId, actionIntent.body, trigger.toISOString(), new Date().toISOString()]
            );

            // SQLite succeeded — now schedule notification
            await Notifications.scheduleNotificationAsync({
              content: { title: 'Herald', body: actionIntent.body, sound: true },
              trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: trigger },
            });

            // One-time Samsung battery optimization prompt
            try {
              const shown = await AsyncStorage.getItem('herald_battery_prompt');
              if (!shown) {
                await AsyncStorage.setItem('herald_battery_prompt', 'true');
                setTimeout(() => {
                  addMessage({
                    id: generateId('msg'),
                    role: 'assistant',
                    content: `One tip: to make sure reminders always reach you, go to Settings → Battery → App power management and set Herald to "Unrestricted". Samsung sometimes delays notifications otherwise.`,
                    timestamp: Date.now(),
                  });
                }, 3000);
              }
            } catch {}

            const displayTime = trigger.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const reply = `I'll remind you to ${actionIntent.body} at ${displayTime}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `Something went wrong setting that reminder. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }
        // Note capture — write to device SQLite, zero network
        if (actionIntent.type === 'note_capture') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const { getDB } = await import('../../db/schema');
            const db = getDB();
            db.runSync(
              `INSERT INTO notes (id, body, created_at, updated_at) VALUES (?, ?, ?, ?);`,
              [`note_${Date.now()}`, actionIntent.body, new Date().toISOString(), new Date().toISOString()]
            );
            const reply = `Got it — noted.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `Something went wrong saving that note. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        // Note read — read from device SQLite, zero network
        if (actionIntent.type === 'note_read') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const { getDB } = await import('../../db/schema');
            const db = getDB();
            const notes = db.getAllSync<{ body: string; created_at: string }>(
              `SELECT body, created_at FROM notes ORDER BY created_at DESC LIMIT 10;`
            );
            const reply = notes.length === 0
              ? `You don't have any notes yet.`
              : `Here are your notes: ${notes.map(n => n.body).join('. ')}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `I couldn't read your notes right now. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        // List add — write to device SQLite, zero network
        if (actionIntent.type === 'list_add') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const { getDB } = await import('../../db/schema');
            const db = getDB();
            const { items, listName } = actionIntent;
            let list = db.getFirstSync<{ id: string }>(`SELECT id FROM lists WHERE name = ?;`, [listName]);
            if (!list) {
              const listId = `list_${Date.now()}`;
              db.runSync(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?);`, [listId, listName, new Date().toISOString()]);
              list = { id: listId };
            }
            for (const item of items) {
              db.runSync(
                `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, 0, ?);`,
                [`item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, list.id, item, new Date().toISOString()]
              );
            }
            const preview = items.length <= 3
              ? items.join(', ')
              : `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`;
            const reply = items.length === 1
              ? `Added ${items[0]} to your ${listName} list.`
              : `Added ${items.length} items to your ${listName} list: ${preview}. Sound right?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `Something went wrong adding that. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        // List read — read from device SQLite, zero network
        if (actionIntent.type === 'list_read') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const { getDB } = await import('../../db/schema');
            const db = getDB();
            const listName = actionIntent.listName;
            const items = db.getAllSync<{ body: string }>(
              `SELECT li.body FROM list_items li
               JOIN lists l ON l.id = li.list_id
               WHERE l.name = ? AND li.checked = 0
               ORDER BY li.created_at ASC;`,
              [listName]
            );
            // Dedup — case-insensitive, keep first occurrence
            const seen = new Set<string>();
            const unique = items.filter(i => {
              const key = i.body.trim().toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            const deterministicReply = unique.length === 0
              ? `Your ${listName} list is empty.`
              : `On your ${listName} list: ${unique.map(i => i.body).join(', ')}.`;
            let reply = deterministicReply;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `I couldn't read your list right now. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        // List remove — soft-delete via checked=1, zero network
        if (actionIntent.type === 'list_remove') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const db = getDB();
            const { item, listName } = actionIntent;
            const matches = db.getAllSync<{ id: string; body: string }>(
              `SELECT li.id, li.body FROM list_items li
               JOIN lists l ON l.id = li.list_id
               WHERE l.name = ? AND li.checked = 0
               AND lower(li.body) LIKE lower(?)`,
              [listName, `%${item}%`],
            );
            let reply: string;
            if (matches.length === 0) {
              reply = `I don't see ${item} on your ${listName} list.`;
            } else if (matches.length === 1) {
              db.runSync(
                `UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ?;`,
                [new Date().toISOString(), matches[0].id],
              );
              const remaining = db.getAllSync<{ body: string }>(
                `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
                 WHERE l.name = ? AND li.checked = 0 ORDER BY li.created_at ASC;`,
                [listName]
              );
              const seenLeft = new Set<string>();
              const left = remaining.map(r => r.body).filter(b => {
                const k = b.trim().toLowerCase();
                if (seenLeft.has(k)) return false;
                seenLeft.add(k);
                return true;
              });
              reply = left.length === 0
                ? `Done — ${matches[0].body} is off your ${listName} list. That clears it.`
                : `Done — ${matches[0].body} is off. Still on your ${listName} list: ${left.join(', ')}.`;
            } else {
              reply = `I see a few matches for ${item} — which one did you mean?`;
            }
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `Something went wrong removing that. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        // List clear — mark all unchecked items checked=1, zero network
        if (actionIntent.type === 'list_clear') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const db = getDB();
            const { listName } = actionIntent;
            const list = db.getFirstSync<{ id: string }>(`SELECT id FROM lists WHERE name = ?;`, [listName]);
            if (!list) {
              const reply = `Your ${listName} list is already empty.`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
            } else {
              const openCount = db.getFirstSync<{ n: number }>(
                `SELECT COUNT(*) as n FROM list_items WHERE list_id = ? AND checked = 0;`,
                [list.id],
              )?.n ?? 0;
              if (openCount === 0) {
                const reply = `Your ${listName} list is already empty.`;
                addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
                speak(reply);
              } else {
                db.runSync(
                  `UPDATE list_items SET checked = 1, removed_at = ? WHERE list_id = ? AND checked = 0;`,
                  [new Date().toISOString(), list.id],
                );
                const reply = `Cleared your ${listName} list.`;
                addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
                speak(reply);
              }
            }
          } catch {
            const reply = `Something went wrong clearing that list. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        // List update — fuzzy match + UPDATE body, zero network
        if (actionIntent.type === 'list_update') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const db = getDB();
            const { oldItem, newItem, listName } = actionIntent;
            const matches = db.getAllSync<{ id: string; body: string }>(
              `SELECT li.id, li.body FROM list_items li
               JOIN lists l ON l.id = li.list_id
               WHERE l.name = ? AND li.checked = 0
               AND lower(li.body) LIKE lower(?)`,
              [listName, `%${oldItem}%`],
            );
            let reply: string;
            if (matches.length === 0) {
              reply = `I don't see ${oldItem} on your ${listName} list.`;
            } else if (matches.length === 1) {
              const prevBody = matches[0].body;
              db.runSync(`UPDATE list_items SET body = ? WHERE id = ?;`, [newItem, matches[0].id]);
              reply = `Updated ${prevBody} to ${newItem} on your ${listName} list.`;
            } else {
              reply = `I see a few matches for ${oldItem} — which one did you mean?`;
            }
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `Something went wrong updating that. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        if (actionIntent.type === 'todo_add') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const { getDB } = await import('../../db/schema');
            const db = getDB();
            let todoList = db.getFirstSync<{ id: string }>(`SELECT id FROM lists WHERE name = ?;`, ['todos']);
            if (!todoList) {
              const listId = `list_todos_${Date.now()}`;
              db.runSync(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?);`, [listId, 'todos', new Date().toISOString()]);
              todoList = { id: listId };
            }
            db.runSync(
              `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, 0, ?);`,
              [`todo_${Date.now()}`, todoList.id, actionIntent.body, new Date().toISOString()]
            );
            const openCount = db.getFirstSync<{ n: number }>(
              `SELECT COUNT(*) as n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'todos' AND li.checked = 0;`
            )?.n ?? 1;
            const reply = openCount === 1
              ? `Got it — '${actionIntent.body}' is on your list.`
              : `Got it — '${actionIntent.body}' added. You've got ${openCount} open to-dos.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `Couldn't save that. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        if (actionIntent.type === 'todo_read') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const { getDB } = await import('../../db/schema');
            const db = getDB();
            const items = db.getAllSync<{ body: string }>(
              `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'todos' AND li.checked = 0 ORDER BY li.created_at ASC;`
            );
            const reply = items.length === 0
              ? `You're all clear — nothing on your to-do list.`
              : `You've got ${items.length} open: ${items.map(i => i.body).join(', ')}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `Couldn't read your to-dos right now. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }

        if (actionIntent.type === 'todo_complete') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const { getDB } = await import('../../db/schema');
            const db = getDB();
            const items = db.getAllSync<{ id: string; body: string }>(
              `SELECT li.id, li.body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'todos' AND li.checked = 0;`
            );
            if (items.length === 0) {
              const reply = `Nothing open on your to-do list.`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
              return;
            }
            const rawLower = actionIntent.raw.toLowerCase();
            const stopWords = new Set(['i','the','a','an','to','of','and','or','my','me','it','that','this','have','had','been','was','did','do']);
            const keywords = rawLower.split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));
            let bestMatch: { id: string; body: string } | null = null;
            let bestScore = 0;
            for (const item of items) {
              const itemLower = item.body.toLowerCase();
              const score = keywords.filter(k => itemLower.includes(k)).length;
              if (score > bestScore) { bestScore = score; bestMatch = item; }
            }
            if (!bestMatch || bestScore === 0) {
              const reply = `I couldn't match that to anything on your list. Want me to read your to-dos?`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
              return;
            }
            pendingTodoCompleteRef.current = bestMatch;
            const reply = `Just to make sure — you're saying you've completed '${bestMatch.body}'? I can mark that off your list.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } catch {
            const reply = `Something went wrong. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }
}
