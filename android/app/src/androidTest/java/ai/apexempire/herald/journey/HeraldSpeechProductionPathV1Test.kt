package ai.apexempire.herald.journey

import android.util.Log
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.apexempire.herald.MainActivity
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Drives the production open-speech admission chain under the retired classifier.
 * The envelope is booleans and enums only.
 */
@RunWith(AndroidJUnit4::class)
class HeraldSpeechProductionPathV1Test {
  companion object {
    private const val TAG = "HeraldSpeechProductionPath"
    private const val HOST_TIMEOUT_MS = 90_000L
    private const val TTS_PROBE_TIMEOUT_MS = 5_000L
    private const val PROBE_TIMEOUT_MS = 180_000L
  }

  @get:Rule
  val activityRule = ActivityScenarioRule(MainActivity::class.java)

  @After
  fun tearDown() {
    HeraldJourneyBridge.requestHostTeardown()
  }

  @Test
  fun speechProductionPath_realAdmissionChain() {
    if (!HeraldJourneyBridge.awaitHostReady(HOST_TIMEOUT_MS)) {
      fail("RUNNER_FAIL JOURNEY_HOST_NOT_READY")
    }
    val pre = JSONObject(HeraldJourneyBridge.probeSpeechPreconditions(TTS_PROBE_TIMEOUT_MS))
    emit(pre)
    if (pre.optString("ttsBinding") == "missing") fail("PRECONDITION_FAIL tts_state_unbound")
    if (!pre.optBoolean("ttsIdle", false)) fail("PRECONDITION_FAIL tts_not_idle")
    val json = JSONObject(HeraldJourneyBridge.probeSpeechProductionPath(PROBE_TIMEOUT_MS))
    emit(json)
    if (json.optString("schema") != "herald.journey.deterministic_speech_path.v1") {
      fail("RUNNER_FAIL unexpected schema")
    }
    if (json.optString("status") != "PASS") {
      fail("PROOF_FAIL ${json.optString("failReason")}")
    }
    val required = arrayOf(
      "speechBoundaryEntered",
      "continuationGapElapsed",
      "speechAdmissionRequested",
      "speechResolverReturned",
      "classifierContextNull",
      "speechSendStarted",
      "sendProcessingReturned",
    )
    for (key in required) {
      if (!json.optBoolean(key, false)) fail("PROOF_MISSING $key")
    }
    if (json.optString("speechProposal") != "uncertain") fail("PROOF_MISSING speechProposal")
    if (json.optBoolean("speechNativeCompletionObserved", true)) fail("PROOF_MISSING speechNativeCompletionObserved")
    if (json.optBoolean("incompleteExtensionTaken", true)) fail("PROOF_MISSING incompleteExtensionTaken")
    if (json.optInt("transcriptDeliveryCount", 0) != 1) fail("PROOF_MISSING transcriptDeliveryCount")
  }

  private fun emit(json: JSONObject) {
    val bundle = android.os.Bundle()
    bundle.putString("json", json.toString())
    InstrumentationRegistry.getInstrumentation().sendStatus(2, bundle)
    Log.i(TAG, json.toString())
  }
}
