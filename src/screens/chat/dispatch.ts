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
import type { ConversationalSubjectHolder } from '../../routing/conversationalSubject';
import type { MedicationPresentationHolder } from '../../routing/medicationPresentation';
import type { OrderedPresentationHolder } from '../../routing/orderedPresentation';
// Type-only: erased at compile time, never resolves the real
// expo-intent-launcher module. The runtime value is loaded lazily at each
// call site below (harness compatibility fix, 2026-09-07, same pattern as
// src/db/schema.ts's expo-sqlite fix and src/db/calendarCacheDB.ts's
// expo-calendar fix: expo-intent-launcher imports 'react-native' for real,
// and react-native's entry uses Flow's `import typeof` syntax, which raw
// esbuild/tsx cannot parse outside Metro — a static top-level import here
// made the headless heraldTest harness un-loadable via run.mjs -> ... ->
// dispatch.ts, independent of whether an intent launch ever actually
// happens (tests never reach real device intent launches).
import type * as IntentLauncher from 'expo-intent-launcher';

async function getIntentLauncherRuntime(): Promise<typeof IntentLauncher> {
  return import('expo-intent-launcher');
}
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDB } from '../../db/schema';
import { isPersonalDestination, isRelationshipTerm, RELATIONSHIP_WORDS, resolvePersonIdentity, contactHasCapability, resolvePersonCapability } from '../../db/contactsDB';
import { osNameQuery, osNameFullyCovered } from '../../utils/osContactDestination';
import { normalizePersonTarget, liftRelationshipName } from '../../utils/personReference';
import { answerHouseholdRead } from '../../utils/householdRead';
import { guessMedicationName, deactivateMedicationByName } from '../../db/medicalDB';
import { isMedicationCorroborated } from '../../db/factDB';
import type { CommitResult } from '../../routing/routeIntent';
import { matchCandidateToken } from '../../routing/conversationSession';
import {
  bindCallTextRecovery,
  bindOsFiniteSmsDisambiguate,
  CALL_TEXT_RECOVERY_KEY,
  isUnresolvedPersonRef,
  SMS_OS_DISAMBIGUATE_KEY,
  type CallTextGap,
  type CallTextTask,
} from '../../routing/callTextReadiness';

// Pending-confirmation refs the dispatch handlers set so the NEXT user turn can
// resolve them (collect a phone number, confirm a medication, etc.).
export interface DispatchPendingRefs {
  pendingContactCollectRef: MutableRefObject<{ action: 'call' | 'navigate' | 'text' | 'confirm_phone' | 'confirm_call'; name: string; body?: string; phone?: string } | null>;
}

const SESSION_OWNED_CONTACT_PENDING_KEYS = new Set([
  CALL_TEXT_RECOVERY_KEY,
  SMS_OS_DISAMBIGUATE_KEY,
  'sms_disambiguate_os_capability',
  'contact_call',
]);

/** True when ConversationSession already owns Call/Text recovery or CALL confirm/collect. */
export function sessionOwnsContactPending(session: ConversationSession): boolean {
  const key = session.peekPendingKey();
  return key != null && SESSION_OWNED_CONTACT_PENDING_KEYS.has(key);
}

/**
 * Drop leftover collect-ref state when ConversationSession owns the same
 * contact/person job. 911 confirm_call stays — that is emergency confirmation,
 * not Call/Text recovery and not contact_call.
 */
export function releaseOverlappingContactCollect(
  pendingContactCollectRef: DispatchPendingRefs['pendingContactCollectRef'],
  session: ConversationSession,
): void {
  if (!sessionOwnsContactPending(session)) return;
  if (pendingContactCollectRef.current?.action === 'confirm_call') return;
  pendingContactCollectRef.current = null;
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
  resolveContactPhone: (nameOrRelation: string) => Promise<{ phone: string; name: string; contactId?: string; source: 'herald' | 'device' } | { phone: null; name: string; source: 'device'; candidateNames: string[]; deviceCandidates: { name: string; phone: string }[] } | null>;
  handleCalendarAction: (value: string) => Promise<void>;
  handleMapsAction: (query: string) => Promise<void>;
  launchAndroidTimer: (seconds: number) => Promise<boolean>;
  handleLaunchActionRef: MutableRefObject<((appName: string) => Promise<void>) | null>;
  platformOS: string;
  openURL: (url: string) => Promise<void>;
  orderedPresentation?: OrderedPresentationHolder | null;
  medicationPresentation?: MedicationPresentationHolder | null;
  conversationalSubject?: ConversationalSubjectHolder | null;
}

/** Shared launch ACK. True → success copy. False/throw → honest fail. Never "Opening" on fail. */
export function composeLaunchAck(appName: string, opened: boolean): string {
  return opened
    ? `Opening ${appName}.`
    : `I don't have ${appName} set up to open yet — try it manually.`;
}

type LaunchFn = (appName: string) => Promise<unknown>;

/**
 * Run a launcher and compose the ACK from the boolean outcome. Thrown errors
 * are fail-closed (opened=false) — same copy as an explicit false return.
 * Only an explicit `true` counts as opened (void/undefined/false → fail).
 */
export async function launchAppAndCompose(
  appName: string,
  launch?: LaunchFn | null,
): Promise<{ opened: boolean; ack: string }> {
  let opened = false;
  try {
    if (launch) {
      opened = (await launch(appName)) === true;
    }
  } catch {
    opened = false;
  }
  return { opened, ack: composeLaunchAck(appName, opened) };
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
              const IntentLauncher = await getIntentLauncherRuntime();
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
                const IntentLauncher = await getIntentLauncherRuntime();
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

          const completeReadySms = async (ready: CallTextTask): Promise<CommitResult> => {
            if (ready.directPhone?.trim()) {
              const who = ready.contactName.trim() || 'them';
              const smsUrl = `sms:${ready.directPhone.replace(/\D/g, '')}${ready.message ? `?body=${encodeURIComponent(ready.message)}` : ''}`;
              try {
                await openURL(smsUrl);
                const okReply = ready.message
                  ? `Opening a message to ${who} with your note ready.`
                  : `Opening a message to ${who}.`;
                return { status: 'committed', ack: okReply };
              } catch {
                return { status: 'failed', ack: `I couldn't open a message to ${who} — try again.` };
              }
            }
            const identity = resolvePersonIdentity(ready.contactName);
            if (identity.status !== 'single') {
              return { status: 'failed', ack: `I don't have a number for ${ready.contactName}.` };
            }
            const cap = await resolvePersonCapability(identity.contact, 'phone');
            if (cap.status !== 'available') {
              return {
                status: 'failed',
                ack: `I know ${ready.contactName} but I don't have a phone number for them. What's their number?`,
              };
            }
            const smsUrl = `sms:${cap.value.replace(/\D/g, '')}${ready.message ? `?body=${encodeURIComponent(ready.message)}` : ''}`;
            try {
              await openURL(smsUrl);
              const okReply = ready.message
                ? `Opening a message to ${identity.contact.name} with your note ready.`
                : `Opening a message to ${identity.contact.name}.`;
              return { status: 'committed', ack: okReply };
            } catch {
              return { status: 'failed', ack: `I couldn't open a message to ${identity.contact.name} — try again.` };
            }
          };

          const resolveOsPhoneForRecovery = async (query: string) => {
            const device = await resolveContactPhone(query);
            if (device?.phone?.trim()) {
              return { name: device.name, phone: device.phone };
            }
            return null;
          };

          const armSmsRecovery = (
            gap: CallTextGap,
            contactName: string,
            body: string,
            candidateNames: string[] = [],
            spokenQuery?: string,
          ) => {
            const bound = bindCallTextRecovery(
              {
                action: 'sms',
                contactName,
                message: body,
                candidateNames,
                spokenQuery,
                gap,
                turnsAsked: 1,
              },
              resolvePersonIdentity,
              completeReadySms,
              { resolveOsPhone: resolveOsPhoneForRecovery },
            );
            session.setPending({
              pendingKey: bound.pendingKey,
              resume: bound.resume,
              kind: 'standard',
              budget: bound.budget,
              reaskPrompt: bound.reaskPrompt,
              releasePrompt: bound.releasePrompt,
              ownsReply: bound.ownsReply,
            });
            releaseOverlappingContactCollect(pendingContactCollectRef, session);
            addMessage({ id: generateId('msg'), role: 'assistant', content: bound.prompt, timestamp: Date.now() });
            speak(bound.prompt);
          };

          if (isUnresolvedPersonRef(contact)) {
            armSmsRecovery('missing_person', '', message);
            return;
          }

          let resolvedSms;
          try {
            const identity = resolvePersonIdentity(contact);

            const openSmsTo = async (person: { name: string; phone: string }) => {
              const smsUrl = `sms:${person.phone.replace(/\D/g, '')}${message ? `?body=${encodeURIComponent(message)}` : ''}`;
              await openURL(smsUrl);
              const reply = message
                ? `Opening a message to ${person.name} with your note ready.`
                : `Opening a message to ${person.name}.`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
            };

          const armMissingPhoneRecovery = (name: string, opts?: { heraldKnown?: boolean }) => {
            const bound = bindCallTextRecovery(
              {
                action: 'sms',
                contactName: name,
                message: message,
                candidateNames: [],
                spokenQuery: name,
                gap: 'missing_phone',
                turnsAsked: 1,
                recipientKnown: opts?.heraldKnown === true,
              },
              resolvePersonIdentity,
              completeReadySms,
              { resolveOsPhone: resolveOsPhoneForRecovery },
            );
            session.setPending({
              pendingKey: bound.pendingKey,
              resume: bound.resume,
              kind: 'standard',
              budget: bound.budget,
              reaskPrompt: bound.reaskPrompt,
              releasePrompt: bound.releasePrompt,
              ownsReply: bound.ownsReply,
            });
            releaseOverlappingContactCollect(pendingContactCollectRef, session);
            addMessage({ id: generateId('msg'), role: 'assistant', content: bound.prompt, timestamp: Date.now() });
            speak(bound.prompt);
          };

            if (identity.status === 'ambiguous') {
              const names = identity.candidates.map(c => c.name.trim()).filter(Boolean);
              if (names.length < 2) {
                armMissingPhoneRecovery(contact);
                return;
              }
              armSmsRecovery('ambiguous_person', '', message, names, contact);
              return;
            }

            if (identity.status === 'single') {
              const only = identity.contact;

              // OS-multi-always-ask (state doc §9, locked 2026-07-28): check broad
              // device cardinality on the ORIGINAL spoken reference before trusting
              // Herald's single identity. resolvePersonCapability must not receive
              // the raw utterance. Cardinality is derived exclusively from
              // phone-bearing deviceCandidates — candidateNames is never used for
              // the count, and no candidate without a phone is ever selectable.
              const osLookup = osNameQuery(contact, only.name);
              const broadSms = osLookup
                ? await resolveContactPhone(osLookup)
                : await resolveContactPhone(contact);
              const reachableCandidates =
                broadSms &&
                !broadSms.phone &&
                'deviceCandidates' in broadSms
                  ? broadSms.deviceCandidates.filter(c => !!c.phone?.trim())
                  : [];
              const broadIsMulti = reachableCandidates.length > 1;

              if (!broadIsMulti) {
                const cap = await resolvePersonCapability(only, 'phone');
                if (cap.status === 'available') {
                  if (!message.trim()) {
                    armSmsRecovery('missing_content', only.name, '');
                    return;
                  }
                  await openSmsTo({ name: only.name, phone: cap.value });
                  return;
                }
                if (broadSms?.phone && osNameFullyCovered(osLookup || contact, broadSms.name)) {
                  if (!message.trim()) {
                    armSmsRecovery('missing_content', broadSms.name, '');
                    return;
                  }
                  await openSmsTo({ name: broadSms.name, phone: broadSms.phone });
                  return;
                }
                if (cap.status === 'ambiguous') {
                  const smsCandidates = cap.candidates.map(c => ({ label: c.name, ref: c.id }));
                  const byId = new Map(cap.candidates.map(c => [c.id, c]));
                  const names = cap.candidates.map(c => c.name).join(', ');
                  const reply = `I found more than one ${only.name} in your contacts — ${names}. Which one did you mean?`;
                  addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
                  speak(reply);
                  session.setPending({
                    pendingKey: 'sms_disambiguate_os_capability',
                    kind: 'standard',
                    reaskPrompt: `I'm not sure I caught that — which one did you mean: ${names}?`,
                    resume: async (replyText: string): Promise<CommitResult> => {
                      const match = matchCandidateToken(replyText, smsCandidates);
                      if (match === 'ambiguous' || match === 'none') return { status: 'noop', ack: '' };
                      const picked = byId.get(match.ref);
                      if (!picked || !contactHasCapability(picked, 'phone')) {
                        return { status: 'failed', ack: `I don't have a number for ${match.label}. What's their number?` };
                      }
                      const smsUrl = `sms:${picked.phone!.replace(/\D/g, '')}${message ? `?body=${encodeURIComponent(message)}` : ''}`;
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
                  releaseOverlappingContactCollect(pendingContactCollectRef, session);
                  return;
                }
                armMissingPhoneRecovery(only.name, { heraldKnown: true });
                return;
              }
              // broadIsMulti === true: fall through — resolvedSms holds the
              // multi result; the shared block below builds the prompt from
              // deviceCandidates only.
              resolvedSms = broadSms;
            } else {
              // identity.status === 'none' — temporary exception: existing OS fall-through.
              resolvedSms = await resolveContactPhone(osNameQuery(contact) || contact);
            }

            if (resolvedSms?.phone) {
              if (!message.trim()) {
                armSmsRecovery('missing_content', resolvedSms.name, '');
              } else {
                await openSmsTo({ name: resolvedSms.name, phone: resolvedSms.phone });
              }
            } else if (
              resolvedSms &&
              !resolvedSms.phone &&
              'deviceCandidates' in resolvedSms &&
              resolvedSms.deviceCandidates.filter(c => !!c.phone?.trim()).length > 0
            ) {
              // Only phone-bearing candidates are ever selectable — a name that
              // cannot be texted is not a candidate, per the Contact Candidacy
              // Rule (action-capability, not data completeness).
              const reachable = resolvedSms.deviceCandidates.filter(c => !!c.phone?.trim());
              const names = reachable.map(c => c.name).join(', ');
              const reply = `I found more than one ${contact} in your contacts — ${names}. Which one did you mean?`;
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
              const boundOs = bindOsFiniteSmsDisambiguate(
                reachable.map(c => ({ name: c.name, phone: c.phone })),
                message,
                contact,
                async (person) => {
                  const smsUrl = `sms:${person.phone}${message ? `?body=${encodeURIComponent(message)}` : ''}`;
                  try {
                    await openURL(smsUrl);
                    const okReply = message
                      ? `Opening a message to ${person.name} with your note ready.`
                      : `Opening a message to ${person.name}.`;
                    return { status: 'committed', ack: okReply };
                  } catch {
                    return { status: 'failed', ack: `I couldn't open a message to ${person.name} — try again.` };
                  }
                },
              );
              session.setPending({
                pendingKey: boundOs.pendingKey,
                kind: 'standard',
                budget: boundOs.budget,
                reaskPrompt: boundOs.reaskPrompt,
                releasePrompt: boundOs.releasePrompt,
                resume: boundOs.resume,
              });
              releaseOverlappingContactCollect(pendingContactCollectRef, session);
            } else {
              if (RELATIONSHIP_WORDS.test(contact.trim())) {
                const bare = contact.trim().replace(/^(my|our|his|her|their)\s+/i, '');
                const reply = `I don't know who your ${bare} is yet. Tell me their name and I'll remember them.`;
                addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
                speak(reply);
                return;
              }
              armMissingPhoneRecovery(contact);
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
          const opened = await handleLaunchActionRef.current?.('photos') ?? false;
          const reply = opened
            ? 'Opening your photos.'
            : "I couldn't open your gallery — try opening Photos manually.";
          addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
          speak(reply);
          return;
        }

        if (actionIntent.type === 'app_open') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const { appName: rawAppName } = actionIntent;
          const isCameraPhrase =
            rawAppName.toLowerCase().includes('camera') ||
            /\b(selfie|picture|photo|photograph|pic)\b/i.test(text);
          const appName = isCameraPhrase ? 'camera' : rawAppName;
          const { ack } = await launchAppAndCompose(appName, async (name) => {
            if (isCameraPhrase) {
              const IntentLauncher = await getIntentLauncherRuntime();
              await IntentLauncher.startActivityAsync('android.media.action.IMAGE_CAPTURE', {});
              return true;
            }
            return await handleLaunchActionRef.current?.(name) ?? false;
          });
          addMessage({ id: generateId('msg'), role: 'assistant', content: ack, timestamp: Date.now() });
          speak(ack);
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

        // Call — routes through the one contact_call authority (DD-2,
        // PENDING_UNIFICATION Commit C1). No legacy ref: applyIntents arms the
        // session if the writer returns a collect/confirm pending.
        if (actionIntent.type === 'call') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const { resolveContactCallIntent } = await import('../../routing/routeIntent');
          const { applyIntents } = await import('../../routing/processUtterance');
          const rawContact = actionIntent.contact ?? '';
          if (isUnresolvedPersonRef(rawContact)) {
            const bound = bindCallTextRecovery(
              {
                action: 'call',
                contactName: '',
                message: '',
                candidateNames: [],
                gap: 'missing_person',
                turnsAsked: 1,
              },
              resolvePersonIdentity,
              async (ready) => {
                const callIntent = await resolveContactCallIntent(ready.contactName, `call ${ready.contactName}`, {
                  resolveContact: resolveContactPhone,
                });
                const { responseText, commits } = await applyIntents([callIntent], `call ${ready.contactName}`, session, undefined, 'deterministic');
                const first = commits[0];
                if (first) return first;
                return { status: 'noop', ack: responseText };
              },
            );
            session.setPending({
              pendingKey: bound.pendingKey,
              resume: bound.resume,
              kind: 'standard',
              budget: bound.budget,
              reaskPrompt: bound.reaskPrompt,
              releasePrompt: bound.releasePrompt,
              ownsReply: bound.ownsReply,
            });
            releaseOverlappingContactCollect(pendingContactCollectRef, session);
            addMessage({ id: generateId('msg'), role: 'assistant', content: bound.prompt, timestamp: Date.now() });
            speak(bound.prompt);
            return;
          }
          const callIntent = await resolveContactCallIntent(rawContact, text, {
            resolveContact: resolveContactPhone,
          });
          const { responseText, commits } = await applyIntents([callIntent], text, session, undefined, 'deterministic');
          releaseOverlappingContactCollect(pendingContactCollectRef, session);
          addMessage({ id: generateId('msg'), role: 'assistant', content: responseText, timestamp: Date.now() });
          speak(responseText);
          for (const c of commits) {
            if (c.status === 'committed' && c.effect?.kind === 'dial') {
              try { await openURL(`tel:${c.effect.phone}`); }
              catch { /* effect failAck already composed into responseText path */ }
            }
          }
          return;
        }

        // Navigation — resolve contact/address on device, fire maps intent (zero-tap)
        if (actionIntent.type === 'navigation') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          const raw = actionIntent.destination;

          const cleaned = liftRelationshipName(normalizePersonTarget(raw));
          const identity = resolvePersonIdentity(raw);

          // Returns CommitResult so the multi-match resume path can reuse it.
          // announce (default true): length===1 speaks here; resume passes
          // announce:false so ChatScreen's pending_resume speak owns the ack.
          const openOrCollectAddress = async (
            contact: { name: string; address?: string | null },
            opts?: { announce?: boolean },
          ): Promise<CommitResult> => {
            const announce = opts?.announce !== false;
            const hasAddress = contactHasCapability(
              {
                id: '',
                name: contact.name,
                importance: 0,
                created_at: '',
                updated_at: '',
                address: contact.address ?? undefined,
              },
              'address',
            );
            if (hasAddress) {
              try {
                await handleMapsAction(contact.address!);
                const reply = `Opening directions to ${contact.name}.`;
                if (announce) {
                  addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
                  speak(reply);
                }
                return { status: 'committed', ack: reply };
              } catch {
                const fail = `I couldn't open directions to ${contact.name} — try again.`;
                if (announce) {
                  addMessage({ id: generateId('msg'), role: 'assistant', content: fail, timestamp: Date.now() });
                  speak(fail);
                }
                return { status: 'failed', ack: fail };
              }
            }
            const reply = `I know ${contact.name} but I don't have an address for them. What's their address?`;
            if (announce) {
              addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
              speak(reply);
            }
            pendingContactCollectRef.current = { action: 'navigate', name: contact.name };
            return { status: 'noop', ack: reply };
          };

          if (identity.status === 'ambiguous') {
            const navCandidates = identity.candidates.map(c => ({ label: c.name, ref: c.id }));
            const byId = new Map(identity.candidates.map(c => [c.id, c]));
            const names = identity.candidates.map(c => c.name).join(', ');
            const reply = `I found more than one ${cleaned} in your contacts — ${names}. Which one did you mean?`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            session.setPending({
              pendingKey: 'navigate_disambiguate_herald',
              kind: 'standard',
              reaskPrompt: `I'm not sure I caught that — which one did you mean: ${names}?`,
              resume: async (replyText: string): Promise<CommitResult> => {
                const match = matchCandidateToken(replyText, navCandidates);
                if (match === 'ambiguous' || match === 'none') return { status: 'noop', ack: '' };
                const picked = byId.get(match.ref);
                if (!picked) {
                  return { status: 'failed', ack: `I couldn't find that contact — try again?` };
                }
                return openOrCollectAddress(picked, { announce: false });
              },
            });
            return;
          }

          if (identity.status === 'single') {
            await openOrCollectAddress(identity.contact);
            return;
          }

          // identity.status === 'none' — place search or honest personal miss (no top-1 helpers).
          if (isPersonalDestination(raw, cleaned)) {
            // Unresolved PERSONAL destination. Never claim navigation started,
            // never hand a personal phrase to a Maps text search. No pending,
            // no contact row — a relationship word is not an identity.
            // [Spine §4 ACK-matches-commit, §5, §3a Law 5; CLAUDE.md Graceful Confusion]
            const reply = isRelationshipTerm(cleaned)
              ? `I don't have your ${cleaned} saved yet. You can tell me anytime — just say "my ${cleaned} is ..." and I'll remember.`
              : `I don't have an address for ${cleaned} yet.`;
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
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

        // List remove — soft-delete via checked=1, zero network.
        // Split on comma / " and " (same as list_add) so "I got milk and bread"
        // checks each piece individually instead of one literal blob.
        if (actionIntent.type === 'list_remove') {
          addMessage({ id: generateId('msg'), role: 'user', content: text, timestamp: Date.now() });
          try {
            const db = getDB();
            const { item, listName } = actionIntent;
            const pieces = item
              .split(/\s*,\s*|\s+and\s+/i)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            const targets = pieces.length > 0 ? pieces : [item];
            const removed: string[] = [];
            const missing: string[] = [];
            let ambiguous: { piece: string; matches: { id: string; body: string }[] } | null = null;
            for (const piece of targets) {
              const matches = db.getAllSync<{ id: string; body: string }>(
                `SELECT li.id, li.body FROM list_items li
                 JOIN lists l ON l.id = li.list_id
                 WHERE l.name = ? AND li.checked = 0
                 AND lower(li.body) LIKE lower(?)`,
                [listName, `%${piece}%`],
              );
              if (matches.length === 0) {
                missing.push(piece);
              } else if (matches.length === 1) {
                db.runSync(
                  `UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ?;`,
                  [new Date().toISOString(), matches[0].id],
                );
                removed.push(matches[0].body);
              } else {
                ambiguous = { piece, matches };
                break;
              }
            }
            let reply: string;
            let armPending = false;
            let pendingMatches: { id: string; body: string }[] = [];
            if (ambiguous) {
              // Pending Disambiguation Commit 1: arm a candidates pending
              // instead of asking and dropping the answer (Law 2 leak fix).
              pendingMatches = ambiguous.matches;
              reply = `I see a few matches for ${ambiguous.piece} — which one did you mean: ${ambiguous.matches.map(m => m.body).join(', ')}?`;
              armPending = true;
            } else if (removed.length === 0) {
              reply = `I don't see ${targets.join(' or ')} on your ${listName} list.`;
            } else {
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
              const removedPhrase = removed.length === 1 ? removed[0] : removed.join(', ');
              const verb = removed.length === 1 ? 'is' : 'are';
              reply = left.length === 0
                ? `Done — ${removedPhrase} ${verb} off your ${listName} list. That clears it.`
                : `Done — ${removedPhrase} ${verb} off. Still on your ${listName} list: ${left.join(', ')}.`;
              if (missing.length > 0) {
                reply += ` I didn't see ${missing.join(' or ')}.`;
              }
            }
            addMessage({ id: generateId('msg'), role: 'assistant', content: reply, timestamp: Date.now() });
            speak(reply);
            if (armPending) {
              const removeCandidates = pendingMatches.map(m => ({ label: m.body, ref: m.id }));
              session.setPending({
                pendingKey: 'list_remove_disambiguate',
                kind: 'standard',
                reaskPrompt: `I'm not sure which one you meant — ${pendingMatches.map(m => m.body).join(', ')}?`,
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
}
