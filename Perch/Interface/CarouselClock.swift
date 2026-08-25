import Foundation


/// Which index a looping carousel should show at a given moment.
/// Perch's resting readings and its hover pages share this one rule, each
/// keeping its own origin.
/// This type stays clear of SwiftUI so the suite can EXECUTE the real formula;
/// put back inside a view, it could only ever be text-matched.
enum CarouselClock {
    /// Starts on slot zero at `origin`, advances one slot every `seconds`, and
    /// wraps within `count`.
    /// Returns 0 for invalid arguments, or when `now` is earlier than `origin`.
    static func slot(now: Date, origin: Date, count: Int, seconds: TimeInterval) -> Int {
        guard count > 0, seconds > 0 else { return 0 }
        // A negative smaller than one slot is truncated toward zero by `Int`;
        // a clock at least one whole slot behind still forms a negative index.
        return Int(max(0, now.timeIntervalSince(origin)) / seconds) % count
    }
}
