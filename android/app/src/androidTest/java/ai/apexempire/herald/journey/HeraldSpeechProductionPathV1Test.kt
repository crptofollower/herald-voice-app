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
 * Drives the production open-speech admission chain on the live classifier context.
 * The envelope is booleans and context ids only.
 */
@RunWith(AndroidJUnit4::class)
class HeraldSpeechProductionPathV1Test {
  companion object {
    private const val TAG = "HeraldSpeechProductionPath"
    private const val HOST_TIMEOUT_MS = 90_000L
    private const val PROBE_TIMEOUT_MS = 180_000L
    private const val READINESS_TIMEOUT_MS = 25L * 60L * 1000L
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
    val readiness = JSONObject(HeraldJourneyBridge.awaitSemanticEngineReady(READINESS_TIMEOUT_MS))
    if (readiness.optString("gate") != "READY") {
      fail("${readiness.optString("gate")} semantic engine did not reach ready")
    }
    val json = JSONObject(HeraldJourneyBridge.probeSpeechProductionPath(PROBE_TIMEOUT_MS))
    emit(json)
    if (json.optString("schema") != "herald.journey.speech_production_path.v1") {
      fail("RUNNER_FAIL unexpected schema")
    }
    if (json.optString("status") != "PASS") {
      fail("PRODUCT_FAIL ${json.optString("failReason")}")
    }
    val required = arrayOf(
      "speechBoundaryEntered",
      "speechAdmissionRequested",
      "speechSemanticInvoked",
      "speechSemanticSettled",
      "speechTranscriptDelivered",
      "speechSendStarted",
      "classifierInvokedAfterSpeech",
      "sameClassifierContext",
      "turnCompleted",
    )
    for (key in required) {
      if (!json.optBoolean(key, false)) fail("PROOF_MISSING $key")
    }
  }

  private fun emit(json: JSONObject) {
    val bundle = android.os.Bundle()
    bundle.putString("json", json.toString())
    InstrumentationRegistry.getInstrumentation().sendStatus(2, bundle)
    Log.i(TAG, json.toString())
  }
}
