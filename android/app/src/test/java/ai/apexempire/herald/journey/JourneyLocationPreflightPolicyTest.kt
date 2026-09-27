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

  @Test
  fun settingsClientSuccessAllowsSpeechProof() {
    assertEquals(SettingsRead.SATISFIED, ready().settingsFirst)
    assertNull(JourneyLocationPreflightPolicy.failReason(ready()))
  }

  @Test
  fun directResolvableExceptionRequestsResolution() {
    assertEquals(
      SettingsRead.RESOLUTION_REQUIRED,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("ResolvableApiException", null, 6, "RESOLUTION_REQUIRED", true),
      ),
    )
  }

  @Test
  fun wrappedResolvableExceptionRequestsResolution() {
    assertEquals(
      SettingsRead.RESOLUTION_REQUIRED,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("ExecutionException", "ResolvableApiException", 6, "RESOLUTION_REQUIRED", true),
      ),
    )
  }

  @Test
  fun directNonResolvableApiExceptionIsHardFailure() {
    assertEquals(
      SettingsRead.HARD_FAILURE,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("ApiException", null, 8502, "SETTINGS_CHANGE_UNAVAILABLE", false),
      ),
    )
  }

  @Test
  fun wrappedNonResolvableExceptionIsHardFailure() {
    assertEquals(
      SettingsRead.HARD_FAILURE,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("ExecutionException", "ApiException", 8502, "SETTINGS_CHANGE_UNAVAILABLE", false),
      ),
    )
  }

  @Test
  fun unknownExceptionIsHardFailure() {
    assertEquals(
      SettingsRead.HARD_FAILURE,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("IllegalStateException", null, null, null, false),
      ),
    )
  }

  @Test
  fun timeoutAndInterruptionAreHardFailures() {
    assertEquals(
      SettingsRead.HARD_FAILURE,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("TimeoutException", null, null, "Timed out waiting for Task", false),
      ),
    )
    assertEquals(
      SettingsRead.HARD_FAILURE,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("ExecutionException", "TimeoutException", null, null, false),
      ),
    )
    assertEquals(
      SettingsRead.HARD_FAILURE,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("InterruptedException", "ResolvableApiException", 6, "RESOLUTION_REQUIRED", true),
      ),
    )
  }

  @Test
  fun resolutionRequiredStatusRoutesWhenTypeFlagIsFalse() {
    assertEquals(
      SettingsRead.RESOLUTION_REQUIRED,
      JourneyLocationPreflightPolicy.classifySettingsException(
        settingsFailure("ApiException", null, 6, "RESOLUTION_REQUIRED", false),
      ),
    )
  }

  @Test
  fun unresolvedHardFailureBlocksSpeechProof() {
    assertEquals(
      "settings_hard_failure",
      JourneyLocationPreflightPolicy.failReason(ready().copy(settingsFirst = SettingsRead.HARD_FAILURE)),
    )
  }

  @Test
  fun proofProceedsOnlyAfterResolvableSettingsPass() {
    val classified = JourneyLocationPreflightPolicy.classifySettingsException(
      settingsFailure("ExecutionException", "ResolvableApiException", 6, "RESOLUTION_REQUIRED", true),
    )
    assertEquals(SettingsRead.RESOLUTION_REQUIRED, classified)
    assertEquals(
      "resolution_not_attempted",
      JourneyLocationPreflightPolicy.failReason(
        ready().copy(settingsFirst = classified, resolutionRan = false, settingsAfterResolution = null),
      ),
    )
    assertEquals(
      "resolution_failed",
      JourneyLocationPreflightPolicy.failReason(
        ready().copy(
          settingsFirst = classified,
          resolutionRan = true,
          settingsAfterResolution = SettingsRead.HARD_FAILURE,
        ),
      ),
    )
    assertNull(
      JourneyLocationPreflightPolicy.failReason(
        ready().copy(
          settingsFirst = classified,
          resolutionRan = true,
          settingsAfterResolution = SettingsRead.SATISFIED,
        ),
      ),
    )
  }

  @Test
  fun exceptionMarkerRecordsClassCauseStatusAndResolvable() {
    assertEquals(
      "settings_check_exception class=ExecutionException cause=ResolvableApiException status=6 message=RESOLUTION_REQUIRED resolvable=true",
      JourneyLocationPreflightPolicy.settingsExceptionMarker(
        settingsFailure("ExecutionException", "ResolvableApiException", 6, "RESOLUTION_REQUIRED", true),
      ),
    )
    assertEquals(
      "settings_check_exception class=ApiException cause=none status=8502 message=SETTINGS_CHANGE_UNAVAILABLE resolvable=false",
      JourneyLocationPreflightPolicy.settingsExceptionMarker(
        settingsFailure("ApiException", null, 8502, "SETTINGS_CHANGE_UNAVAILABLE", false),
      ),
    )
    assertEquals(
      "settings_check_exception class=IllegalStateException cause=none status=none resolvable=false",
      JourneyLocationPreflightPolicy.settingsExceptionMarker(
        settingsFailure("IllegalStateException", null, null, "user@example.com\nsecret", false),
      ),
    )
    assertEquals(
      "settings_check_exception class=InterruptedException cause=ResolvableApiException status=6 message=RESOLUTION_REQUIRED resolvable=false",
      JourneyLocationPreflightPolicy.settingsExceptionMarker(
        settingsFailure("InterruptedException", "ResolvableApiException", 6, "RESOLUTION_REQUIRED", true),
      ),
    )
  }

  private fun settingsFailure(
    thrownClass: String,
    causeClass: String?,
    statusCode: Int?,
    statusMessage: String?,
    resolvable: Boolean,
  ): SettingsExceptionObservation {
    return SettingsExceptionObservation(thrownClass, causeClass, statusCode, statusMessage, resolvable)
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
