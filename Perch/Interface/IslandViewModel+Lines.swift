import AppKit

/// Each project's line: when its dot goes away, and where pressing its name takes you.
/// Hooks send no reliable end-of-session event, so a dot is dropped after a quiet period;
/// how long is `StalePolicy`'s answer.
extension IslandViewModel {
    /// Takes you to where the project's agent runs. In the Claude app, to that session, through
    /// the app's own link to it; anywhere else (Terminal, iTerm, a code editor) only the app
    /// comes forward, since reaching a window there would need permission to control other
    /// apps. Opening through LaunchServices rather than activating the running app, because
    /// Perch is never the active app, and macOS ignores activation requests from an app in
    /// the background.
    func openHost(of project: ProjectStatus) {
        guard let host = project.host else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        if let link = host.sessionURL {
            NSWorkspace.shared.open(link, configuration: configuration)
            return
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: host.app) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: configuration)
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
