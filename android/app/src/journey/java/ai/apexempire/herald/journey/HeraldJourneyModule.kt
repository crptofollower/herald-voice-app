package ai.apexempire.herald.journey

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class HeraldJourneyModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  override fun getName(): String = "DebugJourneyBridge"

  override fun initialize() {
    super.initialize()
    HeraldJourneyBridge.attach(context)
  }

  override fun invalidate() {
    HeraldJourneyBridge.detach(context)
    super.invalidate()
  }

  @ReactMethod
  fun hostReady() {
    HeraldJourneyBridge.markHostReady()
  }

  @ReactMethod
  fun completeTurn(json: String) {
    HeraldJourneyBridge.completeTurn(json)
  }

  @ReactMethod
  fun addListener(eventName: String?) {
    /* DeviceEventEmitter */
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    /* DeviceEventEmitter */
  }
}
