package ai.apexempire.herald.journey

import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.apexempire.herald.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.FileInputStream

/**
 * Cold-start TTS ownership. Logs event names, budgets, and voice identifiers only.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class HeraldVoiceColdStartV1Test {
  companion object {
    private const val TAG = "HeraldVoiceColdStart"
    private const val HOST_TIMEOUT_MS = 90_000L
    private const val PROBE_TIMEOUT_MS = 90_000L
  }

  private lateinit var scenario: ActivityScenario<MainActivity>

  @After
  fun tearDown() {
    HeraldJourneyBridge.requestHostTeardown()
    if (::scenario.isInitialized) scenario.close()
  }

  @Test
  fun coldThenWarmEmbeddedVoice() {
    shell("pm clear com.google.android.tts")
    shell("logcat -c")
    val cold = launchAndProbe(rearm = false, label = "cold")
    assertNoFailsafeBeforeNativeStart(cold, "cold")
    assertTrue("cold speaking cleared", cold.optBoolean("speakingCleared"))
    assertTrue("cold mic suspension granted", logHasSuspendGrant())
    shell("logcat -c")
    val warm = launchAndProbe(rearm = true, label = "warm", relaunch = false)
    assertNativeTerminal(warm, "warm")
    assertTrue("warm rearm was not blocked", !warm.optBoolean("rearmBlocked"))
    val frames = audioFramesDelivered()
    Log.i(TAG, "AUDIO frames=$frames")
    assertTrue("warm playback wrote PCM frames", frames > 0)
  }

  @Test
  fun offlineEmbeddedVoiceCompletes() {
    shell("svc wifi disable")
    shell("svc data disable")
    try {
      shell("am force-stop com.google.android.tts")
      shell("logcat -c")
      val offline = launchAndProbe(rearm = false, label = "offline")
      assertNativeTerminal(offline, "offline")
      assertTrue("offline speaking cleared", offline.optBoolean("speakingCleared"))
      val pinned = pinnedVoice(offline)
      Log.i(TAG, "OFFLINE_VOICE identifier=$pinned")
      if (pinned != "none" && pinned.isNotEmpty()) {
        assertTrue("offline pin is not the rejected server voice", !pinned.contains("server"))
        assertTrue("offline pin is an on-device voice", pinned.contains("embedded") || pinned.contains("local"))
      }
      val native = shell("logcat -d -v brief")
      assertTrue(
        "offline engine dispatched an embedded voice",
        native.contains("lstm-embedded") || native.contains("embedded"),
      )
    } finally {
      shell("svc wifi enable")
      shell("svc data enable")
    }
  }

  @Test
  fun genuineTtsFailureReleasesSpeaking() {
    shell("pm disable-user --user 0 com.google.android.tts")
    try {
      shell("logcat -c")
      val failed = launchAndProbe(rearm = true, label = "failure")
      assertTrue("failure left speaking", failed.optBoolean("speakingCleared"))
      assertTrue("failure rearm was not blocked", !failed.optBoolean("rearmBlocked"))
      assertTrue("failure ended in the ownership failsafe", ringHasFailsafe(failed))
    } finally {
      shell("pm enable com.google.android.tts")
    }
    if (::scenario.isInitialized) {
      HeraldJourneyBridge.requestHostTeardown()
      scenario.close()
    }
    shell("logcat -c")
    val recovered = launchAndProbe(rearm = false, label = "recovery")
    assertNativeTerminal(recovered, "recovery")
  }

  private fun launchAndProbe(rearm: Boolean, label: String, relaunch: Boolean = true): JSONObject {
    if (relaunch || !::scenario.isInitialized) {
      val blocked = JourneyLocationPreflight.enableBeforeLaunch()
      if (blocked != null) fail("PREFLIGHT_FAIL $blocked")
      scenario = ActivityScenario.launch(MainActivity::class.java)
      val preflight = JourneyLocationPreflight.finishAfterLaunch(scenario)
      if (preflight != null) fail("PREFLIGHT_FAIL $preflight")
      if (!HeraldJourneyBridge.awaitHostReady(HOST_TIMEOUT_MS)) fail("JOURNEY_HOST_NOT_READY")
    }
    val raw = HeraldJourneyBridge.probeColdStartVoice(rearm, PROBE_TIMEOUT_MS)
    val json = JSONObject(raw)
    Log.i(
      TAG,
      "PROBE label=$label status=${json.optString("status")} fail=${json.optString("failReason")} " +
        "sendReturned=${json.optBoolean("sendMessageReturned")} " +
        "speakingBecameTrue=${json.optBoolean("speakingBecameTrue")} " +
        "speakingCleared=${json.optBoolean("speakingCleared")} " +
        "rearmBlocked=${json.optBoolean("rearmBlocked")} " +
        "clearMs=${json.optLong("ttsClearWaitMs")}",
    )
    val ring = json.optJSONArray("ring") ?: JSONArray()
    for (i in 0 until ring.length()) {
      val event = ring.optJSONObject(i) ?: continue
      val extra = event.optJSONObject("extra")
      Log.i(
        TAG,
        "RING label=$label event=${event.optString("event")} " +
          "type=${extra?.optString("type")} reason=${extra?.optString("reason")} " +
          "budgetMs=${extra?.opt("budgetMs")} identifier=${extra?.optString("identifier")} " +
          "coldStart=${extra?.opt("coldStart")} applied=${extra?.optString("applied")} " +
          "warm=${extra?.opt("warm")} voicePinned=${extra?.opt("voicePinned")}",
      )
    }
    if (json.optString("status") != "PASS") fail("$label probe ${json.optString("failReason")}")
    return json
  }

  private fun assertNoFailsafeBeforeNativeStart(json: JSONObject, label: String) {
    val ring = json.optJSONArray("ring")
    if (ring == null) {
      fail("$label missing ring")
      return
    }
    var nativeStart = -1
    var nativeTerminal = -1
    var failsafe = -1
    var coldArmed = false
    var dispatched = false
    for (i in 0 until ring.length()) {
      val event = ring.optJSONObject(i) ?: continue
      val name = event.optString("event")
      val extra = event.optJSONObject("extra")
      if (name == "TTS_NATIVE_START" && nativeStart < 0) nativeStart = i
      if (name == "TTS_TERMINAL" && extra?.optString("type") == "native" && nativeTerminal < 0) nativeTerminal = i
      if (name == "TTS_TERMINAL" && extra?.optString("type") == "failsafe" && failsafe < 0) failsafe = i
      if (name == "TTS_FAILSAFE_ARMED" && extra?.optInt("budgetMs") == 45000) coldArmed = true
      if (name == "EXPO_SPEECH_DISPATCH") dispatched = true
    }
    Log.i(TAG, "COLD_ASSERT dispatched=$dispatched coldArmed=$coldArmed nativeStart=$nativeStart nativeTerminal=$nativeTerminal failsafe=$failsafe")
    assertTrue("$label speech was dispatched", dispatched)
    assertTrue("$label armed the cold ownership budget", coldArmed)
    val completion = listOf(nativeStart, nativeTerminal).filter { it >= 0 }.minOrNull()
    assertTrue("$label native speech started or completed", completion != null)
    if (failsafe >= 0 && completion != null) {
      assertTrue("$label failsafe did not release the turn before native speech", failsafe > completion)
    }
  }

  private fun logHasSuspendGrant(): Boolean {
    val log = shell("logcat -d -v brief")
    return log.contains("already_idle") || log.contains("\"resolution\":\"granted\"")
  }

  private fun pinnedVoice(json: JSONObject): String {
    val ring = json.optJSONArray("ring") ?: return ""
    var identifier = ""
    for (i in 0 until ring.length()) {
      val extra = ring.optJSONObject(i)?.optJSONObject("extra") ?: continue
      val value = extra.optString("identifier")
      if (value.isNotEmpty()) identifier = value
    }
    return identifier
  }

  private fun ringHasFailsafe(json: JSONObject): Boolean {
    val ring = json.optJSONArray("ring") ?: return false
    for (i in 0 until ring.length()) {
      val event = ring.optJSONObject(i) ?: continue
      val extra = event.optJSONObject("extra")
      if (event.optString("event") == "TTS_TERMINAL" && extra?.optString("type") == "failsafe") return true
    }
    return false
  }

  private fun assertNativeTerminal(json: JSONObject, label: String) {
    val ring = json.optJSONArray("ring")
    if (ring == null) {
      fail("$label missing ring")
      return
    }
    var nativeTerminal = false
    var duplicateDispatch = 0
    for (i in 0 until ring.length()) {
      val event = ring.optJSONObject(i) ?: continue
      if (event.optString("event") == "EXPO_SPEECH_DISPATCH") duplicateDispatch += 1
      val extra = event.optJSONObject("extra")
      if (event.optString("event") == "TTS_TERMINAL" && extra?.optString("type") == "native" && extra.optString("applied") == "applied") {
        nativeTerminal = true
      }
    }
    assertTrue("$label native terminal applied", nativeTerminal)
    assertTrue("$label did not dispatch a duplicate utterance", duplicateDispatch == 1)
  }

  private fun audioFramesDelivered(): Int {
    val log = shell("logcat -d -v brief")
    var frames = 0
    for (line in log.lineSequence()) {
      val marker = "frames delivered"
      val at = line.indexOf(marker)
      if (at < 0) continue
      val head = line.substring(0, at)
      val number = head.substringAfterLast("with ").trim().toIntOrNull() ?: continue
      if (number > frames) frames = number
    }
    return frames
  }

  private fun shell(command: String): String {
    val fd = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
    return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }
  }
}
