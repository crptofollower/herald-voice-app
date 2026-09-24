package ai.apexempire.herald.journey

import android.os.Bundle
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
import java.nio.charset.StandardCharsets
import java.util.UUID

/**
 * Real semantic-provider proof. A missing on-device model is MODEL_UNAVAILABLE,
 * not a semantic pass. Spoken text is not graded as proof.
 */
@RunWith(AndroidJUnit4::class)
class HeraldSemanticProofV1Test {
  companion object {
    private const val TAG = "HeraldSemanticProof"
    private const val HOST_TIMEOUT_MS = 90_000L
    private const val TURN_TIMEOUT_MS = 120_000L
    private const val RESET_TIMEOUT_MS = 15_000L
  }

  @get:Rule
  val activityRule = ActivityScenarioRule(MainActivity::class.java)

  @After
  fun tearDown() {
    HeraldJourneyBridge.requestHostTeardown()
  }

  @Test
  fun semanticProofV1_realProvider() {
    if (!HeraldJourneyBridge.awaitHostReady(HOST_TIMEOUT_MS)) {
      fail("RUNNER_FAIL JOURNEY_HOST_NOT_READY")
    }
    val scenarios = loadContract().getJSONArray("scenarios")
    for (s in 0 until scenarios.length()) {
      val scenario = scenarios.getJSONObject(s)
      val scenarioId = scenario.getString("id")
      val reset = JSONObject(HeraldJourneyBridge.resetScenario(RESET_TIMEOUT_MS))
      if (reset.optString("status") != "PASS") {
        fail("RUNNER_FAIL reset $scenarioId ${reset.optString("failReason")}")
      }
      val turns = scenario.getJSONArray("turns")
      for (t in 0 until turns.length()) {
        val turnId = "$scenarioId/${t + 1}/${UUID.randomUUID()}"
        val json = JSONObject(
          HeraldJourneyBridge.submitTurn(
            turnId,
            turns.getJSONObject(t).getString("input"),
            scenarioId,
            t + 1,
            TURN_TIMEOUT_MS,
          ),
        )
        emit("${scenarioId}_T${t + 1}", json)
        if (!json.has("semantic") || json.isNull("semantic")) {
          fail("PROOF_MISSING $scenarioId turn ${t + 1}")
        }
        val semantic = json.getJSONObject("semantic")
        val unavailable = semantic.optString("modelUnavailableReason")
        if (unavailable.isNotEmpty() && unavailable != "null") {
          fail("MODEL_UNAVAILABLE $scenarioId turn ${t + 1} reason=$unavailable")
        }
        if (semantic.optString("schema") != "herald.journey.semantic.v1") {
          fail("PROOF_SCHEMA $scenarioId turn ${t + 1}")
        }
        val dumped = semantic.toString()
        if (dumped.contains("512555") || dumped.contains("metoprolol") || dumped.contains("Maya")) {
          fail("PROOF_PRIVACY $scenarioId turn ${t + 1}")
        }
      }
    }
  }

  private fun loadContract(): JSONObject {
    val ctx = InstrumentationRegistry.getInstrumentation().context
    ctx.assets.open("herald/android.semantic.proof.v1.scenarios.json").use { stream ->
      return JSONObject(stream.readBytes().toString(StandardCharsets.UTF_8))
    }
  }

  private fun emit(label: String, obj: JSONObject) {
    Log.i(TAG, obj.toString())
    InstrumentationRegistry.getInstrumentation().sendStatus(
      0,
      Bundle().apply { putString("herald.journey.$label", obj.toString()) },
    )
  }
}
