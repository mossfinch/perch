import SwiftUI

enum IslandPalette {
    /// The island's ground, closed and open alike — ONE constant, so both
    /// states sit at the same depth. Pure black because the closed island sits
    /// against the notch all day and anything lighter reads as a warm grey
    /// patch beside the bezel.
    ///
    /// ⚠️ Nothing dim may be drawn here at an alpha tuned against a lighter
    /// ground. sRGB is non-linear, so the same alpha emits far less light down
    /// here — dim bars lost 2.4× of their contrast when this went black, and
    /// `FlowSense.dimAlpha` had to be re-derived for it.
    static let capsule = Color(red: 0, green: 0, blue: 0)
    static let paper = Color(red: 0.998, green: 0.996, blue: 0.991)
    static let accent = Color(red: 0.620, green: 0.372, blue: 0.322)
    static let cue = Color(red: 0.93, green: 0.64, blue: 0.56)
    static let idleDot = Color.white.opacity(0.40)
    // Four status colors (traffic-light semantics): blue = working / yellow = waiting on you / green = done / gray = idle (idleDot·paper)
    static let statusWorking = Color(red: 0.28, green: 0.62, blue: 0.98)   // blue
    static let statusWaiting = Color(red: 1.00, green: 0.80, blue: 0.24)   // yellow
    static let statusDone = Color(red: 0.30, green: 0.78, blue: 0.46)      // green

    /// One place for state → color, so the dots and the capsule's counts can
    /// never drift apart. (The bird is not a caller: its idle tint is the paper
    /// color, not the dimmer dot gray.)
    static func color(for status: IslandAgentStatus) -> Color {
        switch status {
        case .idle: return idleDot
        case .working: return statusWorking
        case .waiting: return statusWaiting
        case .done: return statusDone
        }
    }
}
