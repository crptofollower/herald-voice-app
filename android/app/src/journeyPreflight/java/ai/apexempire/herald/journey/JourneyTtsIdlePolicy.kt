package ai.apexempire.herald.journey

enum class TtsIdleWaitDecision { READY, WAIT, BINDING_MISSING, TIMEOUT }

/**
 * Observation-only decision for the Journey speech proof.
 * Production TTS_TERMINAL_FAILSAFE_MS is 12s. This bound is that release
 * plus a short margin so a failsafe clear is visible to the next poll.
 * It does not change the production failsafe.
 */
object JourneyTtsIdlePolicy {
  const val TIMEOUT_MS = 15_000L

  fun decide(
    bindingPresent: Boolean,
    speaking: Boolean,
    elapsedMs: Long,
    timeoutMs: Long = TIMEOUT_MS,
  ): TtsIdleWaitDecision {
    if (!bindingPresent) return TtsIdleWaitDecision.BINDING_MISSING
    if (!speaking) return TtsIdleWaitDecision.READY
    if (elapsedMs >= timeoutMs) return TtsIdleWaitDecision.TIMEOUT
    return TtsIdleWaitDecision.WAIT
  }

  fun mayStartSpeechProof(decision: TtsIdleWaitDecision): Boolean {
    return decision == TtsIdleWaitDecision.READY
  }
}
