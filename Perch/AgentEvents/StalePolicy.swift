import Foundation

/// Staleness policy for project status dots: how long without a new event
/// before a dot gets removed.
///
/// Deliberately a pure-Foundation file taking Bool parameters instead of the
/// status enum (which lives on the AppKit side): this lets behavior tests
/// drive the policy directly — feed "state + quiet duration", assert keep or
/// drop.
enum StalePolicy {
    /// Blue (working) / green (done): drop after 15 minutes without events.
    /// There is no reliable "session ended" signal, so prolonged silence is
    /// the only way to conclude a run is over.
    static let busy: TimeInterval = 15 * 60

    /// Yellow (waiting for approval) gets its own, longer limit: yellow means
    /// "parked here waiting for a human", so it must survive a long absence.
    /// But a session that simply gets closed sends no further events, and a
    /// never-expiring dot would hang forever — 8 hours ≈ one workday; beyond
    /// that, assume the human is gone.
    static let waiting: TimeInterval = 8 * 60 * 60

    static func limit(isWaiting: Bool) -> TimeInterval {
        isWaiting ? waiting : busy
    }

    /// `age` = time since the last event.
    static func isStale(isWaiting: Bool, age: TimeInterval) -> Bool {
        age > limit(isWaiting: isWaiting)
    }
}
