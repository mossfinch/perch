import Foundation

/// The shared model the island uses for one project's current agent status.
///
/// The view and the view model share these states, and the event log uses their protocol
/// names. This file only defines the states and how they are tallied; it does not receive
/// events, infer status, or draw anything. Depending on Foundation alone keeps AppKit and
/// the socket listener out of anything that uses these models or compiles behavior tests.
enum IslandAgentStatus: Hashable {
    case idle
    case working
    case waiting   // waiting on the user to choose or approve; driven by PermissionRequest
    case done      // a completion event arrived; held until this project's next event or a timeout

    /// The protocol name written into the event log.
    /// The return value must stay aligned with the `working`, `waiting`, and `complete` the
    /// hooks send: outside scripts read these stable strings, not Swift's case names.
    var logName: String {
        switch self {
        case .idle: return "idle"
        case .working: return "working"
        case .waiting: return "waiting"
        case .done: return "complete"
        }
    }
}

/// One entry of the capsule's tally: a state and how many projects sit in it.
struct StatusCount: Equatable {
    let status: IslandAgentStatus
    let count: Int
}

/// Aggregates many projects into the status counts the capsule displays.
///
/// The size of the output depends on the finite set of lifecycle states, not on the number
/// of projects: more parallel projects only change each group's number, never add new
/// display entries. This type only tallies; it decides neither the colors nor the layout of
/// those counts.
enum StatusTally {
    /// Lifecycle order, which is also the fixed order of the output and of the capsule's
    /// rendering. Not sorted by count, so a state does not keep changing places as its
    /// number moves.
    static let order: [IslandAgentStatus] = [.working, .waiting, .done]

    /// Returns the non-empty states, with their project counts, in `order`.
    ///
    /// `idle` is not in `order`, so it is never emitted, and states with a count of zero are
    /// omitted too. Callers only receive the working, waiting, or done groups that currently
    /// need to be shown.
    static func counts(_ statuses: [IslandAgentStatus]) -> [StatusCount] {
        order.compactMap { status in
            let n = statuses.filter { $0 == status }.count
            return n > 0 ? StatusCount(status: status, count: n) : nil
        }
    }
}
