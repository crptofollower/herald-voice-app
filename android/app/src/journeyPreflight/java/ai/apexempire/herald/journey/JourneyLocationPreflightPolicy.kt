package ai.apexempire.herald.journey

enum class LocationRead { ENABLED, DISABLED, UNKNOWN }

enum class SettingsRead { SATISFIED, RESOLUTION_REQUIRED, HARD_FAILURE }

enum class ActivityRead { RESUMED_CLEAR, NOT_RESUMED, OVERLAY_PRESENT }

/**
 * Facts read from a SettingsClient failure after walking its cause chain.
 * [resolvable] is the live type/status fact. Routing applies the timeout override.
 */
data class SettingsExceptionObservation(
  val thrownClass: String,
  val causeClass: String?,
  val statusCode: Int?,
  val statusMessage: String?,
  val resolvable: Boolean,
)

data class LocationPreflightObservation(
  val locationBeforeEnable: LocationRead,
  val shellRan: Boolean,
  val shellAccepted: Boolean,
  val locationAfterEnable: LocationRead,
  val settingsFirst: SettingsRead?,
  val resolutionRan: Boolean,
  val settingsAfterResolution: SettingsRead?,
  val activity: ActivityRead,
)

object JourneyLocationPreflightPolicy {
  /** CommonStatusCodes.RESOLUTION_REQUIRED. Literal so this policy does not link Play Services. */
  const val SETTINGS_RESOLUTION_REQUIRED_STATUS = 6

  /**
   * Timeout and interruption are hard failures.
   * A live resolvable type, a status that has a resolution, or status 6 enters the existing fallback.
   * Every other shape fails closed.
   */
  fun classifySettingsException(observation: SettingsExceptionObservation): SettingsRead {
    if (isAwaitControlFailure(observation.thrownClass) || isAwaitControlFailure(observation.causeClass)) {
      return SettingsRead.HARD_FAILURE
    }
    if (observation.resolvable || observation.statusCode == SETTINGS_RESOLUTION_REQUIRED_STATUS) {
      return SettingsRead.RESOLUTION_REQUIRED
    }
    return SettingsRead.HARD_FAILURE
  }

  fun safeStatusMessage(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val oneLine = raw.replace(Regex("[\\r\\n\\t]+"), " ").trim()
    if (oneLine.length > 80) return null
    if (!oneLine.matches(Regex("[A-Za-z0-9 _.:/-]+"))) return null
    return oneLine
  }

  fun settingsExceptionMarker(observation: SettingsExceptionObservation): String {
    val resolvable = classifySettingsException(observation) == SettingsRead.RESOLUTION_REQUIRED
    val message = safeStatusMessage(observation.statusMessage)?.let { " message=$it" }.orEmpty()
    val cause = observation.causeClass ?: "none"
    val status = observation.statusCode?.toString() ?: "none"
    return "settings_check_exception class=${observation.thrownClass} cause=$cause status=$status$message resolvable=$resolvable"
  }

  fun failReason(observation: LocationPreflightObservation): String? {
    if (observation.shellRan && !observation.shellAccepted) return "shell_enable_failed"
    val location = if (observation.shellRan) {
      observation.locationAfterEnable
    } else {
      observation.locationBeforeEnable
    }
    if (location == LocationRead.UNKNOWN) return "location_read_unknown"
    if (location != LocationRead.ENABLED) return "location_not_enabled"
    val settings = when (observation.settingsFirst) {
      null -> return "settings_not_checked"
      SettingsRead.HARD_FAILURE -> return "settings_hard_failure"
      SettingsRead.SATISFIED -> SettingsRead.SATISFIED
      SettingsRead.RESOLUTION_REQUIRED -> {
        if (!observation.resolutionRan) return "resolution_not_attempted"
        observation.settingsAfterResolution ?: return "settings_not_rechecked"
      }
    }
    if (settings != SettingsRead.SATISFIED) return "resolution_failed"
    return when (observation.activity) {
      ActivityRead.RESUMED_CLEAR -> null
      ActivityRead.NOT_RESUMED -> "main_activity_not_resumed"
      ActivityRead.OVERLAY_PRESENT -> "location_overlay_present"
    }
  }

  private fun isAwaitControlFailure(className: String?): Boolean {
    if (className == null) return false
    val simple = className.substringAfterLast('.')
    return simple == "TimeoutException" || simple == "InterruptedException"
  }
}
