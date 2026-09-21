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

@RunWith(AndroidJUnit4::class)
class HeraldAndroidJourneyV1Test {
  companion object {
    private const val TAG = "HeraldJourneyV1"
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

  // Speech ownership probe: HeraldJourneyBridge.probeSpeechLifecycle().
  // Not a @Test on this pack — typed sendMessage remains the FTL V1 front door
  // until a later authorized Firebase speech run.

  @Test
  fun androidJourneyV1Pack_packagedSendMessage() {
    val suiteStart = System.currentTimeMillis()
    if (!HeraldJourneyBridge.awaitHostReady(HOST_TIMEOUT_MS)) {
      emit("HOST_NOT_READY", JSONObject(HeraldJourneyBridge.hostNotReadyResult()))
      fail("RUNNER_FAIL JOURNEY_HOST_NOT_READY")
    }
    val contract = loadContract()
    val scenarios = contract.getJSONArray("scenarios")
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
        val failures = gradeTurn(scenarioId, t + 1, json, expect)
        if (failures.isNotEmpty()) {
          val kind = classify(json, failures)
          fail("$kind $scenarioId turn ${t + 1}: ${failures.joinToString(" | ")}")
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
    return "PRODUCT_FAIL"
  }

  private fun gradeTurn(scenarioId: String, turn: Int, got: JSONObject, expect: JSONObject): List<String> {
    val out = mutableListOf<String>()
    if (got.optString("status") != "PASS") {
      out.add("terminal=${got.optString("status")} reason=${got.optString("failReason")}")
      return out
    }
    if (got.optString("turnId").isBlank()) out.add("missing turnId")
    if (got.optString("inputNormalized").isBlank() && expect.getString("input").isNotBlank()) {
      out.add("missing inputNormalized")
    }
    val routing = got.optJSONObject("routing") ?: JSONObject()
    val sqlite = got.optJSONObject("sqlite") ?: JSONObject()
    val delta = sqlite.optJSONObject("delta") ?: JSONObject()
    val after = sqlite.optJSONObject("after") ?: JSONObject()
    val listItems = after.optJSONArray("list_items") ?: after.optJSONArray("items") ?: JSONArray()

    if (expect.has("pending_key_after")) {
      val expected = if (expect.isNull("pending_key_after")) "" else expect.optString("pending_key_after")
      val actual = if (routing.isNull("pending_key_after")) routing.optString("pendingKey") else routing.optString("pending_key_after")
      val actualNorm = if (actual == "null") "" else actual
      if (expected != actualNorm) out.add("pending_key_after got=$actualNorm expected=$expected")
    }
    if (expect.has("pending_key_before") && !expect.isNull("pending_key_before")) {
      val expected = expect.optString("pending_key_before")
      val actual = routing.optString("pending_key_before")
      if (expected != actual) out.add("pending_key_before got=$actual expected=$expected")
    }
    if (expect.has("route_source") && !expect.isNull("route_source")) {
      val expected = expect.optString("route_source")
      val actual = routing.optString("route_source")
      if (expected != actual) out.add("route_source got=$actual expected=$expected")
    }
    if (expect.has("route_kind") && !expect.isNull("route_kind")) {
      val expected = expect.optString("route_kind")
      val actual = routing.optString("route_kind")
      if (expected != actual) out.add("route_kind got=$actual expected=$expected")
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
    val zeroExpected = expect.optBoolean("zero_delta", false)
    val zeroActual = delta.optBoolean("exact_zero_delta", false)
    if (zeroExpected && !zeroActual) out.add("expected exact zero delta ${delta}")
    if (!zeroExpected && zeroActual) out.add("expected authoritative write, got exact zero delta")
    if (expect.has("lists_added")) {
      val expected = sortedStrings(expect.getJSONArray("lists_added"))
      val actual = sortedStrings(delta.optJSONArray("lists_added") ?: JSONArray())
      if (expected != actual) out.add("lists_added got=$actual expected=$expected")
    }
    if (expect.has("items_added")) {
      val expected = itemKeys(expect.getJSONArray("items_added"))
      val actual = itemKeys(delta.optJSONArray("list_items_added") ?: JSONArray())
      if (expected != actual) out.add("list_items_added got=$actual expected=$expected")
    }
    if (expect.has("open_todos")) {
      val expected = sortedList(jsonStringList(expect.getJSONArray("open_todos")))
      val actual = sortedList(openBodies(listItems, "todos"))
      if (expected != actual) out.add("open_todos got=$actual expected=$expected")
    }
    if (expect.has("open_grocery")) {
      val expected = sortedList(jsonStringList(expect.getJSONArray("open_grocery")))
      val actual = sortedList(openBodies(listItems, "grocery"))
      if (expected != actual) out.add("open_grocery got=$actual expected=$expected")
    }
    if (expect.has("open_todos_count")) {
      val actual = openBodies(listItems, "todos").size
      if (actual != expect.getInt("open_todos_count")) out.add("open_todos_count got=$actual")
    }
    if (expect.has("open_grocery_count")) {
      val actual = openBodies(listItems, "grocery").size
      if (actual != expect.getInt("open_grocery_count")) out.add("open_grocery_count got=$actual")
    }
    if (expect.has("medications_added")) {
      val actual = delta.optInt("medications_added", -1)
      if (actual != expect.getInt("medications_added")) out.add("medications_added got=$actual")
    }
    if (expect.has("medical_records_added")) {
      val actual = delta.optInt("medical_records_added", -1)
      if (actual != expect.getInt("medical_records_added")) out.add("medical_records_added got=$actual")
    }
    if (expect.has("medications_named")) {
      val expected = sortedStrings(expect.getJSONArray("medications_named"))
      val meds = after.optJSONArray("medications") ?: JSONArray()
      val names = mutableListOf<String>()
      for (i in 0 until meds.length()) {
        val m = meds.getJSONObject(i)
        if (m.optInt("is_active", 1) == 1) names.add(m.optString("name"))
      }
      if (sortedList(names) != expected) out.add("medications_named got=${sortedList(names)} expected=$expected")
    }
    val response = got.optString("response")
    val includes = expect.optJSONArray("response_includes")
    if (includes != null) {
      for (i in 0 until includes.length()) {
        val needle = includes.getString(i)
        if (!response.contains(needle)) out.add("response_includes missing $needle in ${JSONObject.quote(response)}")
      }
    }
    val excludes = expect.optJSONArray("response_excludes")
    if (excludes != null) {
      for (i in 0 until excludes.length()) {
        val needle = excludes.getString(i)
        if (response.contains(needle)) out.add("response_excludes hit $needle")
      }
    }
    if (expect.optString("capability") == "todo_add") {
      if (routing.optString("pending_key_after") == "contact_call" || routing.optString("route_reason") == "contact_call") {
        out.add("not_contact_call failed")
      }
    }
    if (expect.has("capability") && !expect.isNull("capability")) {
      val expected = expect.getString("capability")
      val actual = routing.optString("capability")
      if (expected != actual) out.add("capability got=$actual expected=$expected")
    }
    if (scenarioId.isBlank() || turn < 1) out.add("ids")
    return out
  }

  private fun openBodies(items: JSONArray, listName: String): List<String> {
    val out = mutableListOf<String>()
    for (i in 0 until items.length()) {
      val item = items.getJSONObject(i)
      val name = item.optString("list_name")
      if (name.isEmpty() && listName != "grocery") continue
      if (name.isNotEmpty() && name != listName) continue
      if (listName == "grocery" && name.isEmpty()) {
        /* grocery-only items array from spike compatibility */
      } else if (name != listName) continue
      val checked = item.optInt("checked", 0)
      val removed = item.optString("removed_at", "")
      if (checked == 0 && (removed.isEmpty() || removed == "null")) {
        out.add(item.optString("body"))
      }
    }
    return out
  }

  private fun itemKeys(arr: JSONArray): String {
    val keys = mutableListOf<String>()
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      keys.add("${o.getString("list_name")}:${o.getString("body")}")
    }
    return keys.sorted().toString()
  }

  private fun stringifyArray(arr: JSONArray): String {
    val keys = mutableListOf<String>()
    for (i in 0 until arr.length()) {
      keys.add(if (arr.isNull(i)) "null" else arr.get(i).toString())
    }
    return keys.toString()
  }

  private fun sortedStrings(arr: JSONArray): String {
    return jsonStringList(arr).sorted().toString()
  }

  private fun jsonStringList(arr: JSONArray): List<String> {
    val out = mutableListOf<String>()
    for (i in 0 until arr.length()) out.add(arr.getString(i))
    return out
  }

  private fun sortedList(list: List<String>): String = list.sorted().toString()

  private fun loadContract(): JSONObject {
    val ctx = InstrumentationRegistry.getInstrumentation().context
    ctx.assets.open("herald/android.journey.v1.scenarios.json").use { stream ->
      val text = stream.readBytes().toString(StandardCharsets.UTF_8)
      return JSONObject(text)
    }
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
