import Foundation

/// Decides when the island drops a project status that has stopped updating.
///
/// Callers supply whether a project is waiting for approval and how many seconds have
/// passed since its last event; this type only defines the timeout thresholds. It does not
/// read events, keep state, or decide any color or style in the interface. Depending on
/// Foundation alone and expressing the waiting state as a Bool keeps the policy reusable
/// and testable without pulling in the interface layer.
enum StalePolicy {
    /// Projects that are working or just finished expire after 15 minutes of silence.
    /// These states have no reliable end-of-session event, so a bounded quiet period is
    /// what reclaims a status whose run has probably ended without sending anything more.
    static let busy: TimeInterval = 15 * 60

    /// Projects waiting for approval are allowed 8 hours of silence.
    /// A long stretch without events is normal while waiting, so the threshold is longer
    /// than the others. It still needs an upper bound: a session that is simply closed may
    /// never send another event, and the leftover status would otherwise show forever.
    static let waiting: TimeInterval = 8 * 60 * 60

    /// Returns the timeout, in seconds, that applies to the current state.
    static func limit(isWaiting: Bool) -> TimeInterval {
        isWaiting ? waiting : busy
    }

    /// Reports whether the time since the last event has passed the threshold.
    /// Exactly at the threshold the status is kept; only strictly beyond it counts as stale.
    static func isStale(isWaiting: Bool, age: TimeInterval) -> Bool {
        age > limit(isWaiting: isWaiting)
    }
}
