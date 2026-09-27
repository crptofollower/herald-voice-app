package ai.apexempire.herald.journey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JourneyTtsIdlePolicyTest {
  @Test
  fun missingBindingFailsEvenWhenNotSpeaking() {
    val decision = JourneyTtsIdlePolicy.decide(
      bindingPresent = false,
      speaking = false,
      elapsedMs = 0L,
    )
    assertEquals(TtsIdleWaitDecision.BINDING_MISSING, decision)
    assertFalse(JourneyTtsIdlePolicy.mayStartSpeechProof(decision))
  }

  @Test
  fun alreadyIdlePassesImmediately() {
    val decision = JourneyTtsIdlePolicy.decide(
      bindingPresent = true,
      speaking = false,
      elapsedMs = 0L,
    )
    assertEquals(TtsIdleWaitDecision.READY, decision)
    assertTrue(JourneyTtsIdlePolicy.mayStartSpeechProof(decision))
  }

  @Test
  fun speakingThenIdlePassesOnlyAfterRelease() {
    val waiting = JourneyTtsIdlePolicy.decide(
      bindingPresent = true,
      speaking = true,
      elapsedMs = 100L,
    )
    val released = JourneyTtsIdlePolicy.decide(
      bindingPresent = true,
      speaking = false,
      elapsedMs = 2_400L,
    )
    assertEquals(TtsIdleWaitDecision.WAIT, waiting)
    assertFalse(JourneyTtsIdlePolicy.mayStartSpeechProof(waiting))
    assertEquals(TtsIdleWaitDecision.READY, released)
    assertTrue(JourneyTtsIdlePolicy.mayStartSpeechProof(released))
  }

  @Test
  fun speakingUntilTimeoutFailsClosed() {
    val decision = JourneyTtsIdlePolicy.decide(
      bindingPresent = true,
      speaking = true,
      elapsedMs = JourneyTtsIdlePolicy.TIMEOUT_MS,
    )
    assertEquals(TtsIdleWaitDecision.TIMEOUT, decision)
    assertFalse(JourneyTtsIdlePolicy.mayStartSpeechProof(decision))
  }

  @Test
  fun timeoutBoundCoversTheProductionFailsafeWithoutALongWait() {
    assertTrue(JourneyTtsIdlePolicy.TIMEOUT_MS > 12_000L)
    assertTrue(JourneyTtsIdlePolicy.TIMEOUT_MS <= 20_000L)
  }

  @Test
  fun idleAfterTheBoundStillPasses() {
    val decision = JourneyTtsIdlePolicy.decide(
      bindingPresent = true,
      speaking = false,
      elapsedMs = JourneyTtsIdlePolicy.TIMEOUT_MS + 1_000L,
    )
    assertEquals(TtsIdleWaitDecision.READY, decision)
    assertTrue(JourneyTtsIdlePolicy.mayStartSpeechProof(decision))
  }
}
