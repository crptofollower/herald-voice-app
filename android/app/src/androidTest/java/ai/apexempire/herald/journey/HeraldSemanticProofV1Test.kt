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
    private const val READINESS_TIMEOUT_MS = 25L * 60L * 1000L
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
    val readiness = JSONObject(HeraldJourneyBridge.awaitSemanticEngineReady(READINESS_TIMEOUT_MS))
    emit("SEMANTIC_ENGINE_READINESS", readiness)
    val gate = readiness.optString("gate")
    if (gate != "READY") {
      fail("$gate semantic engine did not reach ready")
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
        if (json.optString("status") != "PASS" || !json.isNull("failReason")) {
          fail("TURN_STATUS $scenarioId turn ${t + 1} status=${json.optString("status")} reason=${json.opt("failReason")}")
        }
        if (!json.has("semantic") || json.isNull("semantic")) {
          fail("PROOF_MISSING $scenarioId turn ${t + 1}")
        }
        val semantic = json.getJSONObject("semantic")
        assertScenarioSemanticPath(scenarioId, t + 1, semantic)
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

  private fun assertScenarioSemanticPath(scenarioId: String, turn: Int, semantic: JSONObject) {
    val needReference = (scenarioId == "semantic_c" && turn == 3)
      || (scenarioId == "semantic_negative" && turn == 5)
    val needPresented = (scenarioId == "semantic_f" && turn == 2)
      || (scenarioId == "semantic_negative" && turn == 2)
    val needPeople = (scenarioId == "semantic_h" && turn == 2)
      || (scenarioId == "semantic_negative" && turn == 4)
    if (needReference || needPresented || needPeople) {
      if (!hasReference(semantic, needPeople, needPresented)) {
        fail("SEMANTIC_PATH_MISSING $scenarioId turn $turn")
      }
    }
    if (scenarioId == "semantic_e" && turn == 1) {
      if (!hasCapability(semantic, "medication.read_summary") || !hasAdmission(semantic, "ADMIT_READ")) {
        fail("SEMANTIC_ADMISSION_MISSING $scenarioId turn $turn")
      }
    }
    if (scenarioId == "semantic_e" && turn == 2 && !hasCapability(semantic, "calendar.read")) {
      fail("SEMANTIC_PATH_MISSING $scenarioId turn $turn")
    }
    if (scenarioId == "semantic_e" && turn == 3) {
      if (!hasCapabilityExcept(semantic, "contact.call") || externalActionArmed(semantic)) {
        fail("SEMANTIC_PATH_MISSING $scenarioId turn $turn")
      }
    }
  }

  private fun invocations(semantic: JSONObject) = semantic.optJSONArray("invocations")

  private fun hasReference(semantic: JSONObject, people: Boolean, presented: Boolean): Boolean {
    val rows = invocations(semantic) ?: return false
    for (i in 0 until rows.length()) {
      val row = rows.optJSONObject(i) ?: continue
      if (row.optString("operation") != "reference_continuation") continue
      val packet = row.optJSONObject("packet")
      if (people && packet?.optBoolean("groundedPeople") != true) continue
      if (presented && packet?.optBoolean("groundedPresentedMaterial") != true) continue
      return true
    }
    return false
  }

  private fun hasCapability(semantic: JSONObject, capability: String): Boolean {
    val rows = invocations(semantic) ?: return false
    for (i in 0 until rows.length()) {
      val row = rows.optJSONObject(i) ?: continue
      if (row.optString("operation") == "capability" && row.optString("proposedCapability") == capability) return true
    }
    return false
  }

  private fun hasCapabilityExcept(semantic: JSONObject, forbidden: String): Boolean {
    val rows = invocations(semantic) ?: return false
    for (i in 0 until rows.length()) {
      val row = rows.optJSONObject(i) ?: continue
      if (row.optString("operation") == "capability" && row.optString("proposedCapability") != forbidden) return true
    }
    return false
  }

  private fun hasAdmission(semantic: JSONObject, decision: String): Boolean {
    val rows = semantic.optJSONArray("admissions") ?: return false
    for (i in 0 until rows.length()) {
      if (rows.optJSONObject(i)?.optString("decision") == decision) return true
    }
    return false
  }

  private fun externalActionArmed(semantic: JSONObject): Boolean {
    return semantic.optJSONObject("execution")?.optBoolean("externalActionArmed") == true
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
