import Foundation

/// Where a project's agent runs: the app, by bundle identifier, and, inside the Claude app or
/// the Codex app, which of its sessions. Both come from the hook and are handed to the system
/// to open, so each is refused outright when it holds a character its kind of name never has.
///
/// The session is the app's own id for it: the Claude app's `local_…`, which it puts in the
/// agent's environment, or the Codex app's conversation, which codex hands the hook. The
/// session id a Claude hook is handed is a different one, and the Claude app's link does not
/// accept it.
struct AgentHost: Equatable {
    static let claudeApp = "com.anthropic.claudefordesktop"
    static let codexApp = "com.openai.codex"

    let app: String
    let session: String?

    /// Nil when there is no usable app: a name with nothing to bring forward does not react.
    /// An unusable session only drops the session.
    init?(app: String, session: String) {
        guard Self.fits(app, extra: [".", "-"]) else { return nil }
        self.app = app
        self.session = Self.fits(session, extra: ["_", "-"]) ? session : nil
    }

    private init(app: String, knownSession: String?) {
        self.app = app
        self.session = knownSession
    }

    /// This event's host, still naming the session already known for the line when the event
    /// names none from the same app. A newer session wins; another app never inherits it.
    func keepingSession(of previous: AgentHost?) -> AgentHost {
        guard session == nil, let previous, previous.app == app else { return self }
        return AgentHost(app: app, knownSession: previous.session)
    }

    /// The app's own link to one of its sessions. Nil for any other app, and without a
    /// session: then only the app comes forward.
    var sessionURL: URL? {
        guard let session else { return nil }
        switch app {
        case Self.claudeApp: return URL(string: "claude://claude.ai/epitaxy/\(session)")
        case Self.codexApp: return URL(string: "codex://threads/\(session)")
        default: return nil
        }
    }

    private static func fits(_ name: String, extra: Set<Character>) -> Bool {
        !name.isEmpty && name.count <= 200
            && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || extra.contains($0)) }
    }
}
