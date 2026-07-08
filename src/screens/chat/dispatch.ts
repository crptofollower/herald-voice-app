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
import type { ConversationSession } from '../../routing/conversationSession';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDB } from '../../db/schema';
import { answerHouseholdRead } from '../../utils/householdRead';
import { guessMedicationName, deactivateMedicationByName } from '../../db/medicalDB';
import { isMedicationCorroborated } from '../../db/factDB';
import type { CommitResult } from '../../routing/routeIntent';
import { matchCandidateToken } from '../../routing/conversationSession';

// Pending-confirmation refs the dispatch handlers set so the NEXT user turn can
// resolve them (collect a phone number, confirm a medication, etc.).
export interface DispatchPendingRefs {
  pendingContactCollectRef: MutableRefObject<{ action: 'call' | 'navigate' | 'text' | 'confirm_phone' | 'confirm_call'; name: string; body?: string; phone?: string } | null>;
}

// Everything the dispatch handlers need from the component, passed explicitly.
export interface DispatchDeps extends DispatchPendingRefs {
  session: ConversationSession;
  addMessage: (m: Message) => void;
  speak: (text: string, opts?: { rate?: number }) => void;
  setInputText: (s: string) => void;
  sendingRef: MutableRefObject<boolean>;
  generateId: (prefix: string) => string;
  llmStatus: string;
  getCtx: () => LlamaContext | null;
  resolveContactPhone: (nameOrRelation: string) => Promise<{ phone: string; name: string; contactId?: string; source: 'herald' | 'device' } | { phone: null; name: string; source: 'device'; candidateNames: string[] } | null>;
  handleCalendarAction: (value: string) => Promise<void>;
  handleMapsAction: (query: string) => Promise<void>;
  launchAndroidTimer: (seconds: number) => Promise<boolean>;
  handleLaunchActionRef: MutableRefObject<((appName: string) => Promise<void>) | null>;
  platformOS: string;
  openURL: (url: string) => Promise<void>;
}

// Tier-1 READ dispatch (calendar/medical/family/profile). Filled in Stage 1.3.
// ALL reads are spoken verbatim from the deterministic layer. No generative
// wrapping path exists (Spine §3 — phrase-out removed, LLM_LIVE P2 / Build A).
export async function dispatchRead(
  response: string,
  text: string,
  deps: DispatchDeps,
): Promise<void> {
  const { addMessage, speak, generateId } = deps;
  // User bubble — added once, here, for the routed read.
  addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });

  addMessage({ id: generateId('msg'), role: 'assistant', content: response, timestamp: Date.now() });
  speak(response);
}

// Tier-1 ACTION dispatch (alarm/timer/sms/calendar/medical/call/nav/reminder/
// note/list/todo/...). Filled in Stage 1.4.
export async function dispatchAction(
  actionIntent: NonNullable<TierDecision['actionIntent']>,
  text: string,
  deps: DispatchDeps,
): Promise<void> {
  const {
    addMessage, speak, generateId, llmStatus, getCtx,
    resolveContactPhone, handleCalendarAction, handleMapsAction, launchAndroidTimer,
    handleLaunchActionRef, pendingContactCollectRef,
    platformOS, openURL, session,
  } = deps;

  // === arms copied from ChatScreen.tsx below ===
        if (actionIntent.type === 'alarm') {
          const { time, label } = actionIntent;
          const [h, m] = time.split(':');
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          let alarmOpened = false;
          if (platformOS === 'android') {
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
          const timerOpened = platformOS === 'android'
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
          let resolvedSms;
          try {
            resolvedSms = await resolveContactPhone(contact);
            if (resolvedSms?.phone) {
              const smsUrl = `sms:${resolvedSms.phone.replace(/\D/g, '')}${message ? `?body=${encodeURIComponent(message)}` : ''}`;
              await openURL(smsUrl);
              const reply = message
                ? `Opening a message to ${resolvedSms.name} with your note ready.`
                : `Opening a message to ${resolvedSms.name}.`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
            } else if (resolvedSms && 'candidateNames' in resolvedSms && resolvedSms.candidateNames.length > 0) {
              // Pending Disambiguation Commit 1: refs-only candidates (names),
              // resolved live at commit time — never a cached phone-less
              // contact. Matches spec PENDING_DISAMBIGUATION_DESIGN_SPEC.md §6.
              const smsCandidates = resolvedSms.candidateNames.map(n => ({ label: n, ref: n }));
              const names = resolvedSms.candidateNames.join(', ');
              const reply = `I found more than one ${contact} in your contacts — ${names}. Which one did you mean?`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
              session.setPending({
                pendingKey: 'sms_disambiguate',
                kind: 'standard',
                reaskPrompt: `I'm not sure I caught that — which one did you mean: ${names}?`,
                resume: async (replyText: string): Promise<CommitResult> => {
                  const match = matchCandidateToken(replyText, smsCandidates);
                  if (match === 'ambiguous' || match === 'none') return { status: 'noop', ack: '' };
                  const picked = await resolveContactPhone(match.ref);
                  if (!picked?.phone) {
                    return { status: 'failed', ack: `I don't have a number for ${match.label}. What's their number?` };
                  }
                  const smsUrl = `sms:${picked.phone.replace(/\D/g, '')}${message ? `?body=${encodeURIComponent(message)}` : ''}`;
                  try {
                    await openURL(smsUrl);
                    const okReply = message
                      ? `Opening a message to ${picked.name} with your note ready.`
                      : `Opening a message to ${picked.name}.`;
                    return { status: 'committed', ack: okReply };
                  } catch {
                    return { status: 'failed', ack: `I couldn't open a message to ${picked.name} — try again.` };
                  }
                },
              });
            } else {
              const reply = `I don't have a number for ${contact}. What's their number?`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
              pendingContactCollectRef.current = { action: 'text', name: contact, body: message };
            }
          } catch (err) {
            console.error('[dispatch sms] openURL failed', resolvedSms?.phone, err);
            const reply = `I couldn't open a message to ${contact} — try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }
        if (actionIntent.type === 'calendar_write') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          await handleCalendarAction(actionIntent.value);
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
          const { DOMAIN_WRITERS } = await import('../../routing/routeIntent');
          const result = await DOMAIN_WRITERS['medical_capture']!.clear();
          if (result.status === 'pending') {
            session.setPending({
              pendingKey: result.pendingKey,
              kind: result.kind ?? 'destructive',
              budget: 1,
              resume: result.resume,
            });
            addMessage({ id: generateId('msg'), role: 'assistant', content: result.prompt, timestamp: Date.now() });
            speak(result.prompt);
            return;
          }
          addMessage({ id: generateId('msg'), role: 'assistant', content: result.ack, timestamp: Date.now() });
          speak(result.ack);
          return;
        }
        if (actionIntent.type === 'household_remove') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const { removeServiceProvider } = await import('../../utils/householdCapture');
          const changed = removeServiceProvider(actionIntent.categories);
          const reply = changed > 0
            ? `Got it — I'll stop keeping a ${actionIntent.spoken} for you.`
            : `I don't have a ${actionIntent.spoken} saved to remove.`;
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }
        if (actionIntent.type === 'household_read') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const reply = answerHouseholdRead(actionIntent.intent);
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }
        if (actionIntent.type === 'photo_open') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          let opened = false;
          if (platformOS === 'android') {
            const photoIntents = [
              'intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.google.android.apps.photos;end',
              'intent:#Intent;action=android.intent.action.VIEW;type=image/*;package=com.sec.android.gallery3d;end',
              'googlephotos://',
            ];
            for (const uri of photoIntents) {
              try {
                await openURL(uri);
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
          const rawContact = actionIntent.contact ?? '';
          const contactName = rawContact
            .replace(/\s+(?:at|on|using|with|via)\b.*/i, '')
            .trim();
          const resolved = await resolveContactPhone(contactName);
          if (resolved?.phone && resolved.source === 'herald') {
            await openURL(`tel:${resolved.phone.replace(/\D/g, '')}`);
            const reply = `Calling ${resolved.name}.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          } else if (resolved?.phone && resolved.source === 'device') {
            const reply = `I found ${resolved.name} in your contacts — want me to call them?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            pendingContactCollectRef.current = { action: 'confirm_call', name: resolved.name, phone: resolved.phone };
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
            let armPending = false;
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
              // Pending Disambiguation Commit 1: arm a candidates pending
              // instead of asking and dropping the answer (Law 2 leak fix).
              reply = `I see a few matches for ${item} — which one did you mean: ${matches.map(m => m.body).join(', ')}?`;
              armPending = true;
            }
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            if (armPending) {
              const removeCandidates = matches.map(m => ({ label: m.body, ref: m.id }));
              session.setPending({
                pendingKey: 'list_remove_disambiguate',
                kind: 'standard',
                reaskPrompt: `I'm not sure which one you meant — ${matches.map(m => m.body).join(', ')}?`,
                resume: async (replyText: string): Promise<CommitResult> => {
                  const match = matchCandidateToken(replyText, removeCandidates);
                  if (match === 'ambiguous' || match === 'none') return { status: 'noop', ack: '' };
                  try {
                    const db2 = getDB();
                    db2.runSync(`UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ?;`, [new Date().toISOString(), match.ref]);
                    const remaining2 = db2.getAllSync<{ body: string }>(
                      `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
                       WHERE l.name = ? AND li.checked = 0 ORDER BY li.created_at ASC;`,
                      [listName]
                    );
                    const seen2 = new Set<string>();
                    const left2 = remaining2.map(r => r.body).filter(b => {
                      const k = b.trim().toLowerCase();
                      if (seen2.has(k)) return false;
                      seen2.add(k);
                      return true;
                    });
                    const okReply = left2.length === 0
                      ? `Done — ${match.label} is off your ${listName} list. That clears it.`
                      : `Done — ${match.label} is off. Still on your ${listName} list: ${left2.join(', ')}.`;
                    return { status: 'committed', ack: okReply };
                  } catch {
                    return { status: 'failed', ack: `Something went wrong removing that. Try again.` };
                  }
                },
              });
            }
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
            let armPending = false;
            if (matches.length === 0) {
              reply = `I don't see ${oldItem} on your ${listName} list.`;
            } else if (matches.length === 1) {
              const prevBody = matches[0].body;
              db.runSync(`UPDATE list_items SET body = ? WHERE id = ?;`, [newItem, matches[0].id]);
              reply = `Updated ${prevBody} to ${newItem} on your ${listName} list.`;
            } else {
              // Pending Disambiguation Commit 1: same fix as list_remove —
              // this site mirrors it exactly and was found during audit,
              // not in the original spec's §6 table (flagged before building).
              reply = `I see a few matches for ${oldItem} — which one did you mean: ${matches.map(m => m.body).join(', ')}?`;
              armPending = true;
            }
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            if (armPending) {
              const updateCandidates = matches.map(m => ({ label: m.body, ref: m.id }));
              session.setPending({
                pendingKey: 'list_update_disambiguate',
                kind: 'standard',
                reaskPrompt: `I'm not sure which one you meant — ${matches.map(m => m.body).join(', ')}?`,
                resume: async (replyText: string): Promise<CommitResult> => {
                  const match = matchCandidateToken(replyText, updateCandidates);
                  if (match === 'ambiguous' || match === 'none') return { status: 'noop', ack: '' };
                  try {
                    const db2 = getDB();
                    db2.runSync(`UPDATE list_items SET body = ? WHERE id = ?;`, [newItem, match.ref]);
                    return { status: 'committed', ack: `Updated ${match.label} to ${newItem} on your ${listName} list.` };
                  } catch {
                    return { status: 'failed', ack: `Something went wrong updating that. Try again.` };
                  }
                },
              });
            }
          } catch {
            const reply = `Something went wrong updating that. Try again.`;
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
            const { DOMAIN_WRITERS } = await import('../../routing/routeIntent');
            const result = await DOMAIN_WRITERS['todo_add']!.remove(bestMatch.id);
            if (result.status === 'pending') {
              session.setPending({
                pendingKey: result.pendingKey,
                kind: result.kind ?? 'standard',
                budget: 2,
                resume: result.resume,
              });
              addMessage({ id: generateId('msg'), role: 'assistant', content: result.prompt, timestamp: Date.now() });
              speak(result.prompt);
              return;
            }
            addMessage({ id: generateId('msg'), role: 'assistant', content: result.ack, timestamp: Date.now() });
            speak(result.ack);
            return;
          } catch {
            const reply = `Something went wrong. Try again.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
          }
          return;
        }
}
