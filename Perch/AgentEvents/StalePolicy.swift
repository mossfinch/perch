import Foundation

/// When the island drops a project status that has stopped updating.
///
/// Foundation only, with the states passed in as Bools, so the policy can be
/// tested without the interface layer.
enum StalePolicy {
    /// Working states have no reliable end-of-session event, so a quiet period
    /// is what clears a run that ended without saying so.
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

    /// The full rule, for any status. `age` is the time since the line's last
    /// event; `sinceSeen` is the time since you opened the card while the line
    /// was finished, or nil if you have not yet.
    ///
    /// A finished line you have not looked at is waiting on you just as a
    /// request for approval is: green means "come back and hand out the next
    /// step", and the person who most needs it is the one who walked away for
    /// longer than `busy`. So it keeps the long limit until you see it, then
    /// gets `busy` counted from that moment, never less, so it does not vanish
    /// under your pointer.
    static func isStale(isWaiting: Bool, isDone: Bool, age: TimeInterval,
                        sinceSeen: TimeInterval?) -> Bool {
        guard isDone else { return isStale(isWaiting: isWaiting, age: age) }
        guard let sinceSeen else { return isStale(isWaiting: true, age: age) }
        return isStale(isWaiting: false, age: sinceSeen)
    }
}
