package ai.apexempire.herald.debug

import ai.apexempire.herald.journey.HeraldJourneyPackage
import com.facebook.react.ReactPackage

class DebugReactPackages {
  companion object {
    @JvmStatic
    fun packages(): List<ReactPackage> = listOf(HeraldJourneyPackage())
  }
}
