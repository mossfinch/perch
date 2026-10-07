import Foundation

/// When the island drops a project status that has stopped updating.
///
/// Foundation only, with the waiting state passed in as a Bool, so the policy
/// can be tested without the interface layer.
enum StalePolicy {
    /// Working and just-finished states have no reliable end-of-session event,
    /// so a quiet period is what clears a run that ended without saying so.
    static let busy: TimeInterval = 15 * 60

    /// A wait for approval is often silent for hours, so this limit is much
    /// longer. It still needs a bound: a session that is simply closed never
    /// sends another event, and its status would otherwise show forever.
    static let waiting: TimeInterval = 8 * 60 * 60

    static func limit(isWaiting: Bool) -> TimeInterval {
        isWaiting ? waiting : busy
    }

    /// A status exactly at the limit is kept; only a longer silence is stale.
    static func isStale(isWaiting: Bool, age: TimeInterval) -> Bool {
        age > limit(isWaiting: isWaiting)
    }
}
