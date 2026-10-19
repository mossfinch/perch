import AppKit

/// Each project's line: when its dot goes away, and where pressing its name takes you.
/// Hooks send no reliable end-of-session event, so a dot is dropped after a quiet period;
/// how long is `StalePolicy`'s answer.
extension IslandViewModel {
    /// Brings forward the app the project's agent runs in: Terminal, iTerm, a code editor,
    /// the Claude app. Only the app, not the window or the session: the Claude app offers no way
    /// in from outside, and reaching a Terminal window would need permission to control
    /// other apps. Opening through LaunchServices rather than activating the running app,
    /// because Perch is never the active app, and macOS ignores activation requests from
    /// an app in the background.
    func openHost(of project: ProjectStatus) {
        guard let id = project.hostApp,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
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
