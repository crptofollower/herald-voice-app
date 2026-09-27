package ai.apexempire.herald.journey

import android.content.Context
import android.content.Intent
import android.location.LocationManager
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiSelector
import ai.apexempire.herald.MainActivity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.ResolvableApiException
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.LocationSettingsRequest
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.Tasks
import java.io.FileInputStream
import java.util.concurrent.TimeUnit

/**
 * AndroidTest-only device-state gate. A normal app launch never calls it.
 */
object JourneyLocationPreflight {
  const val TAG = "HeraldJourneyLocationPreflight"
  private const val RESOLUTION_REQUEST = 0x4C0C

  private var locationBefore = LocationRead.UNKNOWN
  private var shellRan = false
  private var shellAccepted = false
  private var locationAfter = LocationRead.UNKNOWN

  /** Location master switch only. Does not launch Herald. */
  fun enableBeforeLaunch(): String? {
    mark("location_preflight_start")
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    locationBefore = readLocation(context)
    locationAfter = locationBefore
    if (locationBefore != LocationRead.ENABLED) {
      mark("shell_enable_requested")
      shellRan = true
      val output = shell("cmd location set-location-enabled true")
      shellAccepted = output.isBlank() || output.trim().equals("true", ignoreCase = true)
      if (!shellAccepted) Log.i(TAG, "shell_enable_rejected")
      locationAfter = readLocation(context)
    }
    if (shellRan && !shellAccepted) return fail("shell_enable_failed")
    val locationNow = if (shellRan) locationAfter else locationBefore
    if (locationNow == LocationRead.UNKNOWN) return fail("location_read_unknown")
    if (locationNow != LocationRead.ENABLED) return fail("location_not_enabled")
    mark("location_enabled_verified")
    return null
  }

  /** Settings and resumed gate. Call only after MainActivity has launched. */
  fun finishAfterLaunch(scenario: ActivityScenario<MainActivity>): String? {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val settingsFirst = checkSettings(context)
    var resolutionRan = false
    var settingsAfter: SettingsRead? = null
    when (settingsFirst) {
      SettingsRead.SATISFIED -> mark("settings_check_success")
      SettingsRead.HARD_FAILURE -> {
        mark("settings_hard_failure")
        return fail("settings_hard_failure")
      }
      SettingsRead.RESOLUTION_REQUIRED -> {
        mark("resolution_required")
        resolutionRan = true
        resolveSettingsUi(scenario)
        settingsAfter = checkSettings(context)
        if (settingsAfter != SettingsRead.SATISFIED) return fail("resolution_failed")
        mark("resolution_handled")
        mark("settings_check_success")
      }
    }
    returnToMain(scenario)
    val activity = readActivity(scenario)
    val reason = JourneyLocationPreflightPolicy.failReason(
      LocationPreflightObservation(
        locationBeforeEnable = locationBefore,
        shellRan = shellRan,
        shellAccepted = shellAccepted,
        locationAfterEnable = locationAfter,
        settingsFirst = settingsFirst,
        resolutionRan = resolutionRan,
        settingsAfterResolution = settingsAfter,
        activity = activity,
      ),
    )
    if (reason != null) return fail(reason)
    mark("main_activity_resumed_gate_passed")
    mark("preflight_complete")
    mark("speech_proof_start_allowed")
    return null
  }

  private fun readLocation(context: Context): LocationRead {
    val shellText = shell("cmd location is-location-enabled").trim().lowercase()
    val fromShell = when (shellText) {
      "true" -> true
      "false" -> false
      else -> null
    }
    val fromManager = try {
      context.getSystemService(LocationManager::class.java)?.isLocationEnabled
    } catch (_: Exception) {
      null
    }
    if (fromShell == null || fromManager == null || fromShell != fromManager) return LocationRead.UNKNOWN
    return if (fromShell) LocationRead.ENABLED else LocationRead.DISABLED
  }

  private fun checkSettings(context: Context): SettingsRead {
    return try {
      val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10_000L).build()
      val settings = LocationSettingsRequest.Builder().addLocationRequest(request).build()
      Tasks.await(
        LocationServices.getSettingsClient(context).checkLocationSettings(settings),
        10,
        TimeUnit.SECONDS,
      )
      SettingsRead.SATISFIED
    } catch (thrown: Exception) {
      // Tasks.await wraps the task failure in ExecutionException. The Play Services
      // status is on that cause, or on a direct ApiException if the client threw one.
      if (thrown is InterruptedException) Thread.currentThread().interrupt()
      val observed = observeSettingsFailure(thrown)
      mark(JourneyLocationPreflightPolicy.settingsExceptionMarker(observed))
      JourneyLocationPreflightPolicy.classifySettingsException(observed)
    }
  }

  private fun observeSettingsFailure(thrown: Throwable): SettingsExceptionObservation {
    val api = findApiException(thrown)
    val status = api?.status
    val resolvable = api is ResolvableApiException
      || status?.hasResolution() == true
      || api?.statusCode == JourneyLocationPreflightPolicy.SETTINGS_RESOLUTION_REQUIRED_STATUS
    return SettingsExceptionObservation(
      thrownClass = thrown.javaClass.simpleName,
      causeClass = thrown.cause?.javaClass?.simpleName,
      statusCode = api?.statusCode,
      statusMessage = status?.statusMessage,
      resolvable = resolvable,
    )
  }

  private fun findApiException(thrown: Throwable): ApiException? {
    var current: Throwable? = thrown
    val seen = HashSet<Throwable>()
    while (current != null && seen.add(current)) {
      if (current is ApiException) return current
      current = current.cause
    }
    return null
  }

  private fun findResolvable(thrown: Throwable): ResolvableApiException? {
    var current: Throwable? = thrown
    val seen = HashSet<Throwable>()
    while (current != null && seen.add(current)) {
      if (current is ResolvableApiException) return current
      val api = current as? ApiException
      if (api?.status?.hasResolution() == true) return ResolvableApiException(api.status)
      current = current.cause
    }
    return null
  }

  private fun resolveSettingsUi(scenario: ActivityScenario<MainActivity>) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      scenario.onActivity { host ->
        try {
          val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10_000L).build()
          val settings = LocationSettingsRequest.Builder().addLocationRequest(request).setAlwaysShow(true).build()
          LocationServices.getSettingsClient(host).checkLocationSettings(settings)
            .addOnFailureListener { error ->
              val resolvable = findResolvable(error)
              if (resolvable != null) {
                try {
                  resolvable.startResolutionForResult(host, RESOLUTION_REQUEST)
                } catch (_: Exception) {
                  // The settings recheck decides failure.
                }
              }
            }
        } catch (_: Exception) {
          // The settings recheck decides failure.
        }
      }
    }
    Thread.sleep(750)
    val device = UiDevice.getInstance(instrumentation)
    for (label in listOf("Turn on", "OK", "Yes", "Allow")) {
      val button = device.findObject(UiSelector().text(label))
      if (button.waitForExists(1_500)) {
        button.click()
        break
      }
    }
    Thread.sleep(500)
  }

  private fun returnToMain(scenario: ActivityScenario<MainActivity>) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      scenario.onActivity { activity ->
        val intent = Intent(activity, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        activity.startActivity(intent)
      }
    }
    val deadline = System.currentTimeMillis() + 5_000L
    while (System.currentTimeMillis() < deadline && scenario.state != Lifecycle.State.RESUMED) {
      Thread.sleep(100)
    }
  }

  private fun readActivity(scenario: ActivityScenario<MainActivity>): ActivityRead {
    if (overlayPresent()) return ActivityRead.OVERLAY_PRESENT
    return if (scenario.state == Lifecycle.State.RESUMED) {
      ActivityRead.RESUMED_CLEAR
    } else {
      ActivityRead.NOT_RESUMED
    }
  }

  private fun overlayPresent(): Boolean {
    val head = shell("dumpsys activity top").lineSequence().take(30).joinToString("\n")
    return head.contains("LocationSettingsCheckerActivity")
  }

  private fun shell(command: String): String {
    val parcel = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
    parcel.use { descriptor: ParcelFileDescriptor ->
      return FileInputStream(descriptor.fileDescriptor).bufferedReader().use { it.readText() }
    }
  }

  private fun mark(step: String) {
    Log.i(TAG, step)
  }

  private fun fail(reason: String): String {
    Log.i(TAG, "preflight_failed reason=$reason")
    return reason
  }
}
