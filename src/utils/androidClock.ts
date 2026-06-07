// Android clock/timer intent launcher — OEM-aware fallbacks (Bug 4).
import { Linking } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

const SAMSUNG_CLOCK_PACKAGES = [
  'com.sec.android.app.clockpackage',
  'com.samsung.android.clockpackage',
];
const GOOGLE_CLOCK = 'com.google.android.deskclock';
const FLAG_NEW_TASK = 0x10000000;

function timerIntentUrl(seconds: number, packageName?: string, skipUi = true): string {
  const pkg = packageName ? `;package=${packageName}` : '';
  return `intent:#Intent;action=android.intent.action.SET_TIMER;${pkg}i.android.intent.extra.alarm.LENGTH=${seconds};B.android.intent.extra.alarm.SKIP_UI=${skipUi};launchFlags=0x${FLAG_NEW_TASK.toString(16)};end`;
}

async function tryOpenTimerUrl(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

export async function launchAndroidTimer(totalSeconds: number): Promise<boolean> {
  const extra = {
    'android.intent.extra.alarm.LENGTH': totalSeconds,
    'android.intent.extra.alarm.SKIP_UI': true,
    'android.intent.extra.alarm.MESSAGE': 'Herald Timer',
  };

  try {
    await IntentLauncher.startActivityAsync('android.intent.action.SET_TIMER', {
      extra,
      flags: FLAG_NEW_TASK,
    });
    return true;
  } catch {}

  for (const skipUi of [true, false]) {
    if (await tryOpenTimerUrl(timerIntentUrl(totalSeconds, undefined, skipUi))) {
      return true;
    }
    for (const packageName of [GOOGLE_CLOCK, ...SAMSUNG_CLOCK_PACKAGES]) {
      if (await tryOpenTimerUrl(timerIntentUrl(totalSeconds, packageName, skipUi))) {
        return true;
      }
      try {
        await IntentLauncher.startActivityAsync('android.intent.action.SET_TIMER', {
          extra: { ...extra, 'android.intent.extra.alarm.SKIP_UI': skipUi },
          packageName,
          flags: FLAG_NEW_TASK,
        });
        return true;
      } catch {}
    }
  }

  return false;
}
