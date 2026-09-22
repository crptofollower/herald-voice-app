package ai.apexempire.herald.journey

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.apexempire.herald.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Firebase/device proof for TalkSession automatic post-TTS follow-up.
 * The JS host must NOT request a second listen.
 * Production TalkSession is the only allowed follow-up authority.
 */
@RunWith(AndroidJUnit4::class)
class HeraldTalkSessionHandoffV1Test {
  companion object {
    private const val TAG = "HeraldTalkSessionHandoffV1"
    private const val HOST_TIMEOUT_MS = 60_000L
    private const val PROBE_TIMEOUT_MS = 120_000L
  }

  @get:Rule
  val activityRule = ActivityScenarioRule(MainActivity::class.java)

  @After
  fun tearDown() {
    HeraldJourneyBridge.requestHostTeardown()
  }

  @Test
  fun talkSessionAutomaticHandoff_productionFollowup() {
    grantMicPermission()
    if (!HeraldJourneyBridge.awaitHostReady(HOST_TIMEOUT_MS)) {
      emit("HOST_NOT_READY", JSONObject(HeraldJourneyBridge.hostNotReadyResult()))
      fail("RUNNER_FAIL JOURNEY_HOST_NOT_READY")
    }
    val json = JSONObject(HeraldJourneyBridge.probeTalkSessionHandoff(PROBE_TIMEOUT_MS))
    emit("TALK_SESSION_HANDOFF", json)
    if (json.optString("schema") != "herald.journey.talk_session_handoff.v1") {
      fail("RUNNER_FAIL unexpected schema ${json.optString("schema")}")
    }
    if (json.optString("status") != "PASS") {
      fail("PRODUCT_FAIL ${json.optString("failReason")}")
    }
    if (json.optInt("harnessStartRecordingCalls", -1) != 0) {
      fail("PRODUCT_FAIL harness initiated a follow-up listen")
    }
    val requested = json.optJSONArray("recognitionRequested") ?: JSONArray()
    val entryPoints = mutableListOf<String>()
    for (i in 0 until requested.length()) {
      entryPoints.add(requested.getJSONObject(i).optString("entryPoint"))
    }
    if (entryPoints.none { it == "manual_button" }) {
      fail("PRODUCT_FAIL missing manual_button listen")
    }
    if (entryPoints.count { it == "post_tts_handoff" } < 2) {
      fail("PRODUCT_FAIL automatic post_tts_handoff not observed twice")
    }
    if (json.optBoolean("rearmAfterIdle", true)) {
      fail("PRODUCT_FAIL automatic rearm after termination")
    }
    if (json.optBoolean("overlappingTtsStt", true)) {
      fail("PRODUCT_FAIL overlapping TTS/STT")
    }
  }

  private fun grantMicPermission() {
    if (Build.VERSION.SDK_INT < 23) return
    val pkg = InstrumentationRegistry.getInstrumentation().targetContext.packageName
    InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(
      pkg,
      Manifest.permission.RECORD_AUDIO,
    )
  }

  private fun emit(label: String, obj: JSONObject) {
    val payload = obj.toString()
    Log.i(TAG, "HERALD_JOURNEY_${label}_BEGIN")
    Log.i(TAG, payload)
    Log.i(TAG, "HERALD_JOURNEY_${label}_END")
    InstrumentationRegistry.getInstrumentation().sendStatus(
      0,
      Bundle().apply { putString("herald.journey.$label", payload) },
    )
  }
}
