package ai.apexempire.herald.journey

enum class LocationRead { ENABLED, DISABLED, UNKNOWN }

enum class SettingsRead { SATISFIED, RESOLUTION_REQUIRED, HARD_FAILURE }

enum class ActivityRead { RESUMED_CLEAR, NOT_RESUMED, OVERLAY_PRESENT }

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
}
