package ai.apexempire.herald.journey

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
import java.nio.charset.StandardCharsets
import java.util.UUID

/**
 * Five-slice conversational proof. Does not launch the live semantic pack.
 */
@RunWith(AndroidJUnit4::class)
class HeraldFiveSliceJourneyV1Test {
  companion object {
    private const val TAG = "HeraldFiveSliceV1"
    private const val SCENARIO_COUNT = 9
    private const val TURN_GAP_MS = 1100L
    private const val HOST_TIMEOUT_MS = 60_000L
    private const val TURN_TIMEOUT_MS = 45_000L
    private const val RESET_TIMEOUT_MS = 15_000L
  }

  @get:Rule
  val activityRule = ActivityScenarioRule(MainActivity::class.java)

  @After
  fun tearDown() {
    HeraldJourneyBridge.requestHostTeardown()
  }

  @Test
  fun fiveSlicePack_packagedSendMessage() {
    val suiteStart = System.currentTimeMillis()
    if (!HeraldJourneyBridge.awaitHostReady(HOST_TIMEOUT_MS)) {
      emit("HOST_NOT_READY", JSONObject(HeraldJourneyBridge.hostNotReadyResult()))
      fail("RUNNER_FAIL JOURNEY_HOST_NOT_READY")
    }
    val contract = loadContract()
    val scenarios = contract.getJSONArray("scenarios")
    if (scenarios.length() != SCENARIO_COUNT || contract.optInt("scenarioCount") != SCENARIO_COUNT) {
      fail("PRODUCT_FAIL scenario count got=${scenarios.length()} expected=$SCENARIO_COUNT")
    }
    val summary = JSONArray()
    for (s in 0 until scenarios.length()) {
      val scenario = scenarios.getJSONObject(s)
      val scenarioId = scenario.getString("id")
      val reset = JSONObject(HeraldJourneyBridge.resetScenario(RESET_TIMEOUT_MS))
      emit("RESET_$scenarioId", reset)
      if (reset.optString("status") != "PASS") {
        fail("RUNNER_FAIL reset $scenarioId ${reset.optString("failReason")}")
      }
      val turns = scenario.getJSONArray("turns")
      for (t in 0 until turns.length()) {
        if (t > 0) Thread.sleep(TURN_GAP_MS)
        val expect = turns.getJSONObject(t)
        val turnId = "$scenarioId/${t + 1}/${UUID.randomUUID()}"
        val json = JSONObject(
          HeraldJourneyBridge.submitTurn(
            turnId,
            expect.getString("input"),
            scenarioId,
            t + 1,
            TURN_TIMEOUT_MS,
          ),
        )
        emit("${scenarioId}_T${t + 1}", json)
        val failures = gradeTurn(json, expect)
        if (failures.isNotEmpty()) {
          fail("${classify(json, failures)} $scenarioId turn ${t + 1}: ${failures.joinToString(" | ")}")
        }
      }
      summary.put(JSONObject().put("id", scenarioId).put("status", "PASS").put("turns", turns.length()))
    }
    emit(
      "SUITE_SUMMARY",
      JSONObject()
        .put("scenarios", summary)
        .put("encoded_total", scenarios.length())
        .put("wall_ms", System.currentTimeMillis() - suiteStart),
    )
  }

  private fun classify(json: JSONObject, failures: List<String>): String {
    val reason = json.optString("failReason")
    if (reason == "JOURNEY_HOST_NOT_READY" || reason == "timeout" || reason == "react_context_missing" ||
      reason == "send_message_unbound" || reason == "stale_result" || reason == "duplicate_turn_id"
    ) {
      return "RUNNER_FAIL"
    }
    if (!json.optBoolean("sendMessageInvoked", false)) return "ANDROID_INTEGRATION"
    val routing = json.optJSONObject("routing")
    val routeReason = routing?.optString("route_reason") ?: ""
    val routeKind = routing?.optString("route_kind") ?: ""
    if (routeKind == "not_ready" || routeReason.startsWith("llm:not_ready")) return "PROVIDER_UNAVAILABLE"
    return "PRODUCT_FAIL"
  }

  private fun gradeTurn(got: JSONObject, expect: JSONObject): List<String> {
    val out = mutableListOf<String>()
    if (got.optString("status") != "PASS") {
      out.add("terminal=${got.optString("status")} reason=${got.optString("failReason")}")
      return out
    }
    val routing = got.optJSONObject("routing") ?: JSONObject()
    val sqlite = got.optJSONObject("sqlite") ?: JSONObject()
    val delta = sqlite.optJSONObject("delta") ?: JSONObject()
    val after = sqlite.optJSONObject("after") ?: JSONObject()
    val five = got.optJSONObject("fiveSlice")
    if (five == null) {
      out.add("missing fiveSlice")
      return out
    }
    if (five.optString("evidenceClass") != expect.optString("evidenceClass")) {
      out.add("evidenceClass got=${five.optString("evidenceClass")}")
    }
    if (expect.has("scriptedCompletionIds")) {
      val expected = stringifyArray(expect.getJSONArray("scriptedCompletionIds"))
      val actualIds = JSONArray()
      val hits = five.optJSONArray("scriptedCompletions") ?: JSONArray()
      for (i in 0 until hits.length()) actualIds.put(hits.getJSONObject(i).optString("id"))
      if (stringifyArray(actualIds) != expected) out.add("scriptedCompletionIds got=$actualIds expected=$expected")
      if (expect.optString("evidenceClass") == "injected") {
        for (i in 0 until hits.length()) {
          val hit = hits.getJSONObject(i)
          if (hit.optString("text").isEmpty() && hit.optString("id") != "fs-recollection-shadow-abstain") {
            out.add("injected completion ${hit.optString("id")} has empty text")
          }
        }
      }
    }
    if (expect.has("suppliedFocus")) {
      val focus = expect.getString("suppliedFocus")
      val hits = five.optJSONArray("scriptedCompletions") ?: JSONArray()
      var supplied = false
      for (i in 0 until hits.length()) {
        if (hits.getJSONObject(i).optString("text").contains(focus)) supplied = true
      }
      if (!supplied) out.add("suppliedFocus missing $focus")
    }
    gradeRecap(out, five, expect)
    gradeAdmission(out, five, expect)
    gradeMentions(out, five, expect)
    gradeRoute(out, routing, expect)
    gradeSqlite(out, delta, after, expect)
    val response = got.optString("response")
    val includes = expect.optJSONArray("response_includes")
    if (includes != null) {
      for (i in 0 until includes.length()) {
        val needle = includes.getString(i)
        if (!response.contains(needle)) out.add("response_includes missing $needle")
      }
    }
    val excludes = expect.optJSONArray("response_excludes")
    if (excludes != null) {
      for (i in 0 until excludes.length()) {
        val needle = excludes.getString(i)
        if (response.contains(needle)) out.add("response_excludes hit $needle")
      }
    }
    return out
  }

  private fun gradeRecap(out: MutableList<String>, five: JSONObject, expect: JSONObject) {
    val recap = if (five.isNull("immediateRecap")) null else five.optJSONObject("immediateRecap")
    if (expect.optBoolean("immediateRecapAbsent", false)) {
      if (recap != null) out.add("immediateRecap present")
      return
    }
    if (!expect.has("immediateRecap")) return
    val want = expect.getJSONObject("immediateRecap")
    if (recap == null) {
      out.add("immediateRecap missing")
      return
    }
    if (want.has("stageAMatched") && recap.optBoolean("stageAMatched") != want.getBoolean("stageAMatched")) {
      out.add("stageAMatched got=${recap.optBoolean("stageAMatched")}")
    }
    val stageB = recap.optJSONObject("stageB")
    if (want.has("stageBStatus") && stageB?.optString("status") != want.getString("stageBStatus")) {
      out.add("stageB.status got=${stageB?.optString("status")}")
    }
    if (want.has("isImmediateRecap") && stageB?.optBoolean("isImmediateRecap") != want.getBoolean("isImmediateRecap")) {
      out.add("stageB.isImmediateRecap got=${stageB?.optBoolean("isImmediateRecap")}")
    }
    if (want.has("confidenceAtLeast")) {
      val confidence = stageB?.optDouble("confidence", -1.0) ?: -1.0
      if (confidence < want.getDouble("confidenceAtLeast")) out.add("stageB.confidence got=$confidence")
    }
    if (want.has("selectedIndex") && stageB?.optInt("selectedIndex", -1) != want.getInt("selectedIndex")) {
      out.add("stageB.selectedIndex got=${stageB?.optInt("selectedIndex")}")
    }
    if (want.has("selectedCandidateIndex")) {
      val actual = if (recap.isNull("selectedCandidateIndex")) null else recap.opt("selectedCandidateIndex")
      val expected = if (want.isNull("selectedCandidateIndex")) null else want.opt("selectedCandidateIndex")
      if (actual != expected) out.add("selectedCandidateIndex got=$actual expected=$expected")
    }
    if (want.has("finalResult") && recap.optString("finalResult") != want.getString("finalResult")) {
      out.add("finalResult got=${recap.optString("finalResult")}")
    }
  }

  private fun gradeAdmission(out: MutableList<String>, five: JSONObject, expect: JSONObject) {
    if (!expect.has("semanticAdmission")) return
    val want = expect.getJSONObject("semanticAdmission")
    val got = five.optJSONObject("semanticAdmission")
    if (got == null) {
      out.add("semanticAdmission missing")
      return
    }
    if (got.optString("decision") != want.optString("decision")) out.add("admission.decision got=${got.optString("decision")}")
    if (got.optString("reason") != want.optString("reason")) out.add("admission.reason got=${got.optString("reason")}")
  }

  private fun gradeMentions(out: MutableList<String>, five: JSONObject, expect: JSONObject) {
    val actual = five.optJSONArray("discourseMentions") ?: JSONArray()
    if (expect.has("discourseMentionCount") && actual.length() != expect.getInt("discourseMentionCount")) {
      out.add("discourseMentionCount got=${actual.length()}")
    }
    if (!expect.has("discourseMentions")) return
    val want = expect.getJSONArray("discourseMentions")
    if (actual.length() != want.length()) {
      out.add("discourseMentions length got=${actual.length()} expected=${want.length()}")
      return
    }
    for (i in 0 until want.length()) {
      val w = want.getJSONObject(i)
      val g = actual.getJSONObject(i)
      if (g.optString("surfaceSpan") != w.optString("surfaceSpan") ||
        g.optString("kind") != w.optString("kind") ||
        g.optString("status") != w.optString("status") ||
        g.optBoolean("durable") != w.optBoolean("durable")
      ) {
        out.add("discourseMention[$i] got=$g expected=$w")
      }
    }
  }

  private fun gradeRoute(out: MutableList<String>, routing: JSONObject, expect: JSONObject) {
    if (expect.has("pending_key_after")) {
      val expected = if (expect.isNull("pending_key_after")) "" else expect.optString("pending_key_after")
      val actual = routing.optString("pending_key_after")
      val actualNorm = if (actual == "null") "" else actual
      if (expected != actualNorm) out.add("pending_key_after got=$actualNorm expected=$expected")
    }
    if (expect.has("pending_key_before") && !expect.isNull("pending_key_before")) {
      if (routing.optString("pending_key_before") != expect.optString("pending_key_before")) {
        out.add("pending_key_before got=${routing.optString("pending_key_before")}")
      }
    }
    if (expect.has("route_source") && routing.optString("route_source") != expect.optString("route_source")) {
      out.add("route_source got=${routing.optString("route_source")}")
    }
    if (expect.has("route_kind") && routing.optString("route_kind") != expect.optString("route_kind")) {
      out.add("route_kind got=${routing.optString("route_kind")}")
    }
    if (expect.has("route_reason") && routing.optString("route_reason") != expect.optString("route_reason")) {
      out.add("route_reason got=${routing.optString("route_reason")}")
    }
    if (expect.has("commit_statuses")) {
      val expected = stringifyArray(expect.getJSONArray("commit_statuses"))
      val actual = stringifyArray(routing.optJSONArray("commit_statuses") ?: JSONArray())
      if (expected != actual) out.add("commit_statuses got=$actual expected=$expected")
    }
    if (expect.has("commit_pending_keys")) {
      val expected = stringifyArray(expect.getJSONArray("commit_pending_keys"))
      val actual = stringifyArray(routing.optJSONArray("commit_pending_keys") ?: JSONArray())
      if (expected != actual) out.add("commit_pending_keys got=$actual expected=$expected")
    }
    if (expect.has("capability") && routing.optString("capability") != expect.getString("capability")) {
      out.add("capability got=${routing.optString("capability")}")
    }
  }

  private fun gradeSqlite(out: MutableList<String>, delta: JSONObject, after: JSONObject, expect: JSONObject) {
    val zeroExpected = expect.optBoolean("zero_delta", false)
    if (expect.has("zero_delta") && delta.optBoolean("exact_zero_delta", false) != zeroExpected) {
      out.add("exact_zero_delta got=${delta.optBoolean("exact_zero_delta")} expected=$zeroExpected")
    }
    if (expect.has("lists_added")) {
      val expected = sortedStrings(expect.getJSONArray("lists_added"))
      val actual = sortedStrings(delta.optJSONArray("lists_added") ?: JSONArray())
      if (expected != actual) out.add("lists_added got=$actual expected=$expected")
    }
    if (expect.has("open_grocery_count")) {
      val items = after.optJSONArray("list_items") ?: after.optJSONArray("items") ?: JSONArray()
      val actual = openBodies(items, "grocery").size
      if (actual != expect.getInt("open_grocery_count")) out.add("open_grocery_count got=$actual")
    }
    if (expect.has("medications_added") && delta.optInt("medications_added", -1) != expect.getInt("medications_added")) {
      out.add("medications_added got=${delta.optInt("medications_added")}")
    }
    if (expect.has("medications_named")) {
      val expected = sortedStrings(expect.getJSONArray("medications_named"))
      val names = activeMedicationField(after, "name")
      if (sortedList(names) != expected) out.add("medications_named got=${sortedList(names)} expected=$expected")
    }
    if (expect.has("medications_dosage")) {
      val expected = dosageKeys(expect.getJSONArray("medications_dosage"))
      val actual = dosageKeysFromSnapshot(after)
      if (expected != actual) out.add("medications_dosage got=$actual expected=$expected")
    }
  }

  private fun activeMedicationField(after: JSONObject, field: String): List<String> {
    val meds = after.optJSONArray("medications") ?: JSONArray()
    val names = mutableListOf<String>()
    for (i in 0 until meds.length()) {
      val med = meds.getJSONObject(i)
      if (med.optInt("is_active", 1) == 1) names.add(med.optString(field))
    }
    return names
  }

  private fun dosageKeys(arr: JSONArray): String {
    val keys = mutableListOf<String>()
    for (i in 0 until arr.length()) {
      val row = arr.getJSONObject(i)
      keys.add("${row.optString("name")}:${row.optString("dosage")}")
    }
    return keys.sorted().toString()
  }

  private fun dosageKeysFromSnapshot(after: JSONObject): String {
    val meds = after.optJSONArray("medications") ?: JSONArray()
    val keys = mutableListOf<String>()
    for (i in 0 until meds.length()) {
      val med = meds.getJSONObject(i)
      if (med.optInt("is_active", 1) == 1) keys.add("${med.optString("name")}:${med.optString("dosage")}")
    }
    return keys.sorted().toString()
  }

  private fun openBodies(items: JSONArray, listName: String): List<String> {
    val out = mutableListOf<String>()
    for (i in 0 until items.length()) {
      val item = items.getJSONObject(i)
      if (item.optString("list_name") != listName) continue
      val removed = item.optString("removed_at", "")
      if (item.optInt("checked", 0) == 0 && (removed.isEmpty() || removed == "null")) out.add(item.optString("body"))
    }
    return out
  }

  private fun stringifyArray(arr: JSONArray): String {
    val keys = mutableListOf<String>()
    for (i in 0 until arr.length()) keys.add(if (arr.isNull(i)) "null" else arr.get(i).toString())
    return keys.toString()
  }

  private fun sortedStrings(arr: JSONArray): String {
    val out = mutableListOf<String>()
    for (i in 0 until arr.length()) out.add(arr.getString(i))
    return out.sorted().toString()
  }

  private fun sortedList(list: List<String>): String = list.sorted().toString()

  private fun loadContract(): JSONObject {
    val ctx = InstrumentationRegistry.getInstrumentation().context
    ctx.assets.open("herald/android.five-slice.v1.scenarios.json").use { stream ->
      return JSONObject(stream.readBytes().toString(StandardCharsets.UTF_8))
    }
  }

  private fun emit(label: String, obj: JSONObject) {
    val payload = obj.toString()
    Log.i(TAG, "HERALD_FIVE_SLICE_${label}_BEGIN")
    Log.i(TAG, payload)
    Log.i(TAG, "HERALD_FIVE_SLICE_${label}_END")
    InstrumentationRegistry.getInstrumentation().sendStatus(
      0,
      Bundle().apply { putString("herald.fiveSlice.$label", payload) },
    )
  }
}
