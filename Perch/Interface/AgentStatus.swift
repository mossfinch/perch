import Foundation

/// What an agent is doing in one project.
///
/// Deliberately pure Foundation, in its own file: both the view and the view
/// model need it, and the tally below has to be reachable by tests. Left
/// inside `IslandViewModel.swift` it would drag AppKit and the socket
/// listener along, and a test could not compile it on its own — which is how
/// display logic ends up "verified" by grepping the source for words.
enum IslandAgentStatus: Hashable {
    case idle
    case working
    case waiting   // needs your choice/approval (driven by PermissionRequest): yellow, pulsing
    case done      // just finished, not yet seen: persists until the next interaction

    /// The name written into the event log. **Deliberately aligned with the
    /// raw strings the hooks push** (working/waiting/complete), not with the
    /// Swift case names — the log is read by outside scripts, and matching
    /// the wire protocol avoids translating at both ends.
    var logName: String {
        switch self {
        case .idle: return "idle"
        case .working: return "working"
        case .waiting: return "waiting"
        case .done: return "complete"
        }
    }
}

/// One entry of the closed capsule: a state and how many projects sit in it.
struct StatusCount: Equatable {
    let status: IslandAgentStatus
    let count: Int
}

/// How the closed capsule reports many projects at once.
///
/// The capsule has a 44×29pt wing — room for about five dots, while an
/// afternoon of parallel agents easily runs to a dozen projects. Past that
/// point a dot per project stops being readable anyway: the dots carry no
/// names, so "which one went green" was never answerable from the capsule.
/// What is worth knowing at a glance is how many sit in each state, and that
/// is at most three numbers no matter how many projects there are — so the
/// wing can never overflow again.
enum StatusTally {
    /// Lifecycle order, and the order the capsule renders in. Fixed rather
    /// than sorted by count: a group that keeps changing places cannot be
    /// read at a glance.
    static let order: [IslandAgentStatus] = [.working, .waiting, .done]

    /// Non-empty groups only.
    ///
    /// `idle` never appears: it is the absence of news, and a "0 idle" would
    /// be noise. Empty groups are dropped rather than shown as zero for the
    /// same reason — with each group carrying its own color, position is not
    /// what identifies them, so dropping one costs nothing.
    static func counts(_ statuses: [IslandAgentStatus]) -> [StatusCount] {
        order.compactMap { status in
            let n = statuses.filter { $0 == status }.count
            return n > 0 ? StatusCount(status: status, count: n) : nil
        }
    }
}
