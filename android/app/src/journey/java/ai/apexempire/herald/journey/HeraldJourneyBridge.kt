package ai.apexempire.herald.journey

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Journey wait-handle between androidTest and the JS host.
 * Structured JSON is the assertion surface.
 */
object HeraldJourneyBridge {
  private const val TAG = "HeraldJourney"
  private const val SUBMIT_EVENT = "DebugJourneySubmitTurn"
  private const val RESET_EVENT = "DebugJourneyResetScenario"
  private const val TEARDOWN_EVENT = "DebugJourneyTeardown"
  private const val SPEECH_PROBE_EVENT = "DebugJourneySpeechProbe"
  private const val DEFAULT_TIMEOUT_MS = 60_000L
  private const val HOST_READY_TIMEOUT_MS = 60_000L

  private val hostReady = AtomicBoolean(false)
  private val inFlight = AtomicBoolean(false)
  private val waiter = AtomicReference<CountDownLatch?>(null)
  private val lastJson = AtomicReference<String?>(null)
  private val expectedTurnId = AtomicReference<String?>(null)
  private val seenTurnIds = HashSet<String>()
  @Volatile private var reactContext: ReactApplicationContext? = null

  fun attach(context: ReactApplicationContext) {
    reactContext = context
  }

  fun detach(context: ReactApplicationContext) {
    if (reactContext === context) {
      reactContext = null
      hostReady.set(false)
      completeInternal(timeoutJson("host_teardown"))
    }
  }

  fun markHostReady() {
    hostReady.set(true)
  }

  fun isHostReady(): Boolean = hostReady.get()

  fun hostNotReadyResult(): String {
    return failJson("", "", "JOURNEY_HOST_NOT_READY")
  }

  fun awaitHostReady(timeoutMs: Long = HOST_READY_TIMEOUT_MS): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (hostReady.get() && reactContext != null) return true
      Thread.sleep(100)
    }
    return hostReady.get() && reactContext != null
  }

  fun submitTurn(text: String, timeoutMs: Long = DEFAULT_TIMEOUT_MS): String {
    return submitTurn(UUID.randomUUID().toString(), text, null, null, timeoutMs)
  }

  fun submitTurn(
    turnId: String,
    text: String,
    scenarioId: String?,
    turnIndex: Int?,
    timeoutMs: Long = DEFAULT_TIMEOUT_MS,
  ): String {
    if (seenTurnIds.contains(turnId)) {
      return failJson(turnId, text, "duplicate_turn_id")
    }
    if (!inFlight.compareAndSet(false, true)) {
      return failJson(turnId, text, "duplicate_or_in_flight")
    }
    if (!hostReady.get() || reactContext == null) {
      inFlight.set(false)
      return failJson(turnId, text, "JOURNEY_HOST_NOT_READY")
    }
    seenTurnIds.add(turnId)
    lastJson.set(null)
    expectedTurnId.set(turnId)
    val latch = CountDownLatch(1)
    waiter.set(latch)
    val ctx = reactContext
    if (ctx == null) {
      inFlight.set(false)
      waiter.set(null)
      expectedTurnId.set(null)
      return failJson(turnId, text, "react_context_missing")
    }
    try {
      val params = Arguments.createMap()
      params.putString("turnId", turnId)
      params.putString("text", text)
      if (scenarioId != null) params.putString("scenarioId", scenarioId)
      if (turnIndex != null) params.putInt("turnIndex", turnIndex)
      ctx
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(SUBMIT_EVENT, params)
    } catch (e: Exception) {
      inFlight.set(false)
      waiter.set(null)
      expectedTurnId.set(null)
      return failJson(turnId, text, "emit_failed:${e.javaClass.simpleName}")
    }
    val completed = latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    val json = lastJson.get()
    waiter.set(null)
    expectedTurnId.set(null)
    inFlight.set(false)
    if (!completed || json == null) {
      val timeout = timeoutJson("timeout", turnId, text)
      Log.i(TAG, timeout)
      return timeout
    }
    Log.i(TAG, json)
    return json
  }

  fun resetScenario(timeoutMs: Long = DEFAULT_TIMEOUT_MS): String {
    if (!inFlight.compareAndSet(false, true)) {
      return JSONObject().put("schema", "herald.journey.reset.v1").put("status", "FAIL").put("failReason", "duplicate_or_in_flight").toString()
    }
    lastJson.set(null)
    expectedTurnId.set(null)
    val latch = CountDownLatch(1)
    waiter.set(latch)
    val ctx = reactContext
    if (ctx == null) {
      inFlight.set(false)
      waiter.set(null)
      return JSONObject().put("schema", "herald.journey.reset.v1").put("status", "FAIL").put("failReason", "react_context_missing").toString()
    }
    try {
      ctx
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(RESET_EVENT, Arguments.createMap())
    } catch (e: Exception) {
      inFlight.set(false)
      waiter.set(null)
      return JSONObject().put("schema", "herald.journey.reset.v1").put("status", "FAIL").put("failReason", "emit_failed").toString()
    }
    val completed = latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    val json = lastJson.get()
    waiter.set(null)
    inFlight.set(false)
    seenTurnIds.clear()
    return if (!completed || json == null) {
      JSONObject().put("schema", "herald.journey.reset.v1").put("status", "FAIL").put("failReason", "timeout").toString()
    } else json
  }

  fun probeSpeechLifecycle(timeoutMs: Long = 45_000L): String {
    if (!inFlight.compareAndSet(false, true)) {
      return JSONObject().put("schema", "herald.journey.speech_lifecycle.v1").put("status", "FAIL").put("failReason", "duplicate_or_in_flight").toString()
    }
    lastJson.set(null)
    expectedTurnId.set(null)
    val latch = CountDownLatch(1)
    waiter.set(latch)
    val ctx = reactContext
    if (ctx == null) {
      inFlight.set(false)
      waiter.set(null)
      return JSONObject().put("schema", "herald.journey.speech_lifecycle.v1").put("status", "FAIL").put("failReason", "react_context_missing").toString()
    }
    try {
      ctx
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(SPEECH_PROBE_EVENT, Arguments.createMap())
    } catch (e: Exception) {
      inFlight.set(false)
      waiter.set(null)
      return JSONObject().put("schema", "herald.journey.speech_lifecycle.v1").put("status", "FAIL").put("failReason", "emit_failed").toString()
    }
    val completed = latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    val json = lastJson.get()
    waiter.set(null)
    inFlight.set(false)
    return if (!completed || json == null) {
      JSONObject().put("schema", "herald.journey.speech_lifecycle.v1").put("status", "FAIL").put("failReason", "timeout").toString()
    } else json
  }

  fun completeTurn(json: String) {
    val expected = expectedTurnId.get()
    if (expected != null) {
      try {
        val obj = JSONObject(json)
        if (obj.optString("schema") == "herald.journey.turn.v1") {
          val got = obj.optString("turnId")
          if (got.isNotEmpty() && got != expected) {
            completeInternal(failJson(expected, "", "stale_result"))
            return
          }
        }
      } catch (_: Exception) {
        completeInternal(failJson(expected, "", "stale_result"))
        return
      }
    }
    completeInternal(json)
  }

  fun requestHostTeardown() {
    val ctx = reactContext
    if (ctx != null) {
      try {
        ctx
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(TEARDOWN_EVENT, Arguments.createMap())
      } catch (_: Exception) {
      }
    }
    hostReady.set(false)
    seenTurnIds.clear()
    completeInternal(timeoutJson("host_teardown"))
    reactContext = null
  }

  private fun completeInternal(json: String) {
    lastJson.set(json)
    waiter.get()?.countDown()
  }

  private fun failJson(turnId: String, text: String, reason: String): String {
    return JSONObject()
      .put("schema", "herald.journey.turn.v1")
      .put("turnId", turnId)
      .put("submittedText", text)
      .put("inputSource", "typed")
      .put("startedAtMs", System.currentTimeMillis())
      .put("finishedAtMs", System.currentTimeMillis())
      .put("durationMs", 0)
      .put("status", "FAIL")
      .put("failReason", reason)
      .put("sendMessageInvoked", false)
      .put("sendMessageReturned", false)
      .toString()
  }

  private fun timeoutJson(reason: String, turnId: String = UUID.randomUUID().toString(), text: String = ""): String {
    return JSONObject()
      .put("schema", "herald.journey.turn.v1")
      .put("turnId", turnId)
      .put("submittedText", text)
      .put("inputSource", "typed")
      .put("startedAtMs", System.currentTimeMillis())
      .put("finishedAtMs", System.currentTimeMillis())
      .put("durationMs", 0)
      .put("status", if (reason == "timeout") "TIMEOUT" else "FAIL")
      .put("failReason", reason)
      .put("sendMessageInvoked", false)
      .put("sendMessageReturned", false)
      .toString()
  }
}
