package ai.firstclaw.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class FirstClawProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", FirstClawCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", FirstClawCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", FirstClawCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", FirstClawCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", FirstClawCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", FirstClawCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", FirstClawCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", FirstClawCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", FirstClawCapability.Canvas.rawValue)
    assertEquals("camera", FirstClawCapability.Camera.rawValue)
    assertEquals("screen", FirstClawCapability.Screen.rawValue)
    assertEquals("voiceWake", FirstClawCapability.VoiceWake.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", FirstClawScreenCommand.Record.rawValue)
  }
}
