import AppKit

/// Each project's line: when its dot goes away, and where pressing its name takes you.
/// Hooks send no reliable end-of-session event, so a dot is dropped after a quiet period;
/// how long is `StalePolicy`'s answer.
extension IslandViewModel {
    /// Takes you to where the project's agent runs. In the Claude app or the Codex app, to that
    /// session, through the app's own link to it; in Terminal, to its tab, which `TerminalTab`
    /// selects. Anywhere else (iTerm, a code editor), and when the tab cannot be reached, only
    /// the app comes forward.
    func openHost(of project: ProjectStatus) {
        guard let host = project.host else { return }
        if let link = host.sessionURL {
            NSWorkspace.shared.open(link, configuration: Self.activating())
            return
        }
        if let tty = host.terminalTTY {
            TerminalTab.reveal(tty: tty) { found in
                if !found { Self.bringForward(host.app) }
            }
            return
        }
        Self.bringForward(host.app)
    }

    /// Opening through LaunchServices rather than activating the running app, because Perch is
    /// never the active app, and macOS ignores activation requests from an app in the background.
    private static func bringForward(_ app: String) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: app) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: activating())
    }

    private static func activating() -> NSWorkspace.OpenConfiguration {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        return configuration
    }

    func pruneStale() {
        let now = Date()
        let before = projects.count
        projects.removeAll { project in
            StalePolicy.isStale(isWaiting: project.status == .waiting, isDone: project.status == .done,
                                age: now.timeIntervalSince(project.updatedAt),
                                sinceSeen: project.seenAt.map { now.timeIntervalSince($0) })
        }
        if projects.count != before { agentStatus = aggregateStatus() }
    }

    /// Only a hover counts as seeing: the card also opens by itself, and it may do so to an
    /// empty room. The first look is kept, so hovering again does not keep a green alive.
    func markFinishedLinesSeen() {
        let now = Date()
        for i in projects.indices where projects[i].status == .done && projects[i].seenAt == nil {
            projects[i].seenAt = now
        }
    }
}
