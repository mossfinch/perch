import Foundation

/// One project's current agent status, shared by the view and the view model.
///
/// Foundation only, which keeps AppKit and the socket listener out of anything that uses
/// these models, including the behaviour tests that compile this file.
enum IslandAgentStatus: Hashable {
    case idle
    case working
    case waiting   // waiting on the user to choose or approve; driven by PermissionRequest
    case done      // a completion event arrived; held until this project's next event or a timeout

    /// The name written into the event log. It must match the `working`, `waiting` and
    /// `complete` the hooks send: outside scripts read these strings, not Swift's case names.
    var logName: String {
        switch self {
        case .idle: return "idle"
        case .working: return "working"
        case .waiting: return "waiting"
        case .done: return "complete"
        }
    }
}

struct StatusCount: Equatable {
    let status: IslandAgentStatus
    let count: Int
}

/// The capsule's status counts. The output size depends on the lifecycle states, not on the
/// number of projects: more parallel projects change the numbers, never the number of
/// entries.
enum StatusTally {
    /// Lifecycle order, which is also the order the capsule draws. Never sorted by count, so
    /// a state does not change places as its number moves.
    static let order: [IslandAgentStatus] = [.working, .waiting, .done]

    /// Only the non-empty states, in `order`; `idle` is never emitted.
    static func counts(_ statuses: [IslandAgentStatus]) -> [StatusCount] {
        order.compactMap { status in
            let n = statuses.filter { $0 == status }.count
            return n > 0 ? StatusCount(status: status, count: n) : nil
        }
    }

    /// What the capsule counts: every line except those in a system temporary folder.
    ///
    /// An agent that batch-runs another agent (Claude grading with codex, say) opens one
    /// throwaway folder per call, and each finished call would sit in the green count for
    /// hours as a project to come back to, which it never is. A person works in a real
    /// folder. The card still lists these lines; only the numbers leave them out.
    static func counts(lines: [(dir: String, status: IslandAgentStatus)]) -> [StatusCount] {
        counts(lines.filter { !isTemporary($0.dir) }.map(\.status))
    }

    /// macOS's fixed temporary locations, `/private` spelling included. Claude Code's
    /// scratchpad lives under `/private/tmp`. Whole path components only, so `/tmpfiles`
    /// is a real folder.
    private static let temporaryRoots = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]

    private static func isTemporary(_ dir: String) -> Bool {
        temporaryRoots.contains { dir == $0 || dir.hasPrefix($0 + "/") }
    }
}
