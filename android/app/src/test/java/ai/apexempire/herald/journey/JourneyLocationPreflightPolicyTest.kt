package ai.apexempire.herald.journey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JourneyLocationPreflightPolicyTest {
  @Test
  fun locationAlreadyEnabledPassesWithoutResolution() {
    assertNull(JourneyLocationPreflightPolicy.failReason(ready()))
  }

  @Test
  fun locationDisabledAttemptsShellEnable() {
    val reason = JourneyLocationPreflightPolicy.failReason(
      ready().copy(
        locationBeforeEnable = LocationRead.DISABLED,
        shellRan = true,
        shellAccepted = true,
        locationAfterEnable = LocationRead.ENABLED,
      ),
    )
    assertNull(reason)
  }

  @Test
  fun shellEnableFailureBlocksProof() {
    val reason = JourneyLocationPreflightPolicy.failReason(
      ready().copy(
        locationBeforeEnable = LocationRead.DISABLED,
        shellRan = true,
        shellAccepted = false,
        locationAfterEnable = LocationRead.DISABLED,
      ),
    )
    assertEquals("shell_enable_failed", reason)
  }

  @Test
  fun satisfiedSettingsDoNotRequireResolution() {
    val observation = ready().copy(resolutionRan = false, settingsAfterResolution = null)
    assertNull(JourneyLocationPreflightPolicy.failReason(observation))
    assertEquals(false, observation.resolutionRan)
  }

  @Test
  fun resolutionRequiredEntersFallback() {
    val reason = JourneyLocationPreflightPolicy.failReason(
      ready().copy(
        settingsFirst = SettingsRead.RESOLUTION_REQUIRED,
        resolutionRan = false,
        settingsAfterResolution = null,
      ),
    )
    assertEquals("resolution_not_attempted", reason)
  }

  @Test
  fun successfulFallbackRechecksSettings() {
    assertNull(
      JourneyLocationPreflightPolicy.failReason(
        ready().copy(
          settingsFirst = SettingsRead.RESOLUTION_REQUIRED,
          resolutionRan = true,
          settingsAfterResolution = SettingsRead.SATISFIED,
        ),
      ),
    )
  }

  @Test
  fun failedFallbackBlocksSpeechProof() {
    assertEquals(
      "resolution_failed",
      JourneyLocationPreflightPolicy.failReason(
        ready().copy(
          settingsFirst = SettingsRead.RESOLUTION_REQUIRED,
          resolutionRan = true,
          settingsAfterResolution = SettingsRead.RESOLUTION_REQUIRED,
        ),
      ),
    )
  }

  @Test
  fun mainActivityNotResumedBlocksSpeechProof() {
    assertEquals(
      "main_activity_not_resumed",
      JourneyLocationPreflightPolicy.failReason(ready().copy(activity = ActivityRead.NOT_RESUMED)),
    )
  }

  @Test
  fun allPreconditionsAllowSpeechProof() {
    assertNull(JourneyLocationPreflightPolicy.failReason(ready()))
  }

  private fun ready(): LocationPreflightObservation {
    return LocationPreflightObservation(
      locationBeforeEnable = LocationRead.ENABLED,
      shellRan = false,
      shellAccepted = false,
      locationAfterEnable = LocationRead.ENABLED,
      settingsFirst = SettingsRead.SATISFIED,
      resolutionRan = false,
      settingsAfterResolution = null,
      activity = ActivityRead.RESUMED_CLEAR,
    )
  }
}
