package ai.apexempire.herald.journey

import android.util.Log
import org.json.JSONObject

/**
 * AndroidTest-only observation of the existing peekSpeaking signal.
 * It does not stop, drain, or rewrite TTS state.
 */
object JourneyTtsIdleGate {
  const val TAG = "HeraldJourneyTtsIdle"
  private const val POLL_MS = 100L

  fun awaitIdle(probe: () -> String): String? {
    val started = System.currentTimeMillis()
    var announced = false
    while (true) {
      val elapsed = System.currentTimeMillis() - started
      val json = JSONObject(probe())
      val bindingPresent = json.optString("ttsBinding") == "present"
      val speaking = bindingPresent && !json.optBoolean("ttsIdle", false)
      if (!announced) {
        val initial = if (bindingPresent) speaking.toString() else "unbound"
        Log.i(TAG, "tts_idle_wait_start speaking=$initial")
        announced = true
      }
      when (
        JourneyTtsIdlePolicy.decide(
          bindingPresent = bindingPresent,
          speaking = speaking,
          elapsedMs = elapsed,
        )
      ) {
        TtsIdleWaitDecision.READY -> {
          Log.i(TAG, "tts_idle_observed elapsedMs=$elapsed")
          return null
        }
        TtsIdleWaitDecision.BINDING_MISSING -> return "tts_state_unbound"
        TtsIdleWaitDecision.TIMEOUT -> {
          Log.i(TAG, "tts_idle_timeout elapsedMs=$elapsed")
          return "tts_idle_timeout"
        }
        TtsIdleWaitDecision.WAIT -> Thread.sleep(POLL_MS)
      }
    }
  }
}
