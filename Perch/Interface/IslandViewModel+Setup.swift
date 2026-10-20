import Foundation

/// Connecting the agents. Until Perch can hear the agents on this Mac, the card's second row
/// offers to wire them instead of showing a wave that will never move.
///
/// The state (`agentSetup`) has to stay on the class, because `@Published` cannot live in an
/// extension.
extension IslandViewModel {
    enum AgentSetup: Equatable {
        /// Wired, or no agent installed: the row shows the wave and the dots.
        case hidden
        case needsConnect
        /// The hook launcher finds the app at one fixed path, so connecting from anywhere
        /// else would wire the hooks to nothing.
        case notInApplications
        /// A copy macOS runs from a temporary place (see `HookSetup.Status.translocated`).
        case translocated
        case failed(String)
        case connected(codexNeedsTrust: Bool)
        /// The socket in `~/.perch/island` could not be opened, so nothing can arrive.
        case cannotListen(String)
    }

    /// Reads only. Runs at launch and each time the card opens, so an agent installed while
    /// Perch runs is offered the next time anyone looks. Returns whether there is something
    /// to connect.
    @discardableResult
    func refreshAgentSetup() -> Bool {
        // A recording shows the island at work, not the offer.
        guard !DataHome.isDemo else { return false }
        if let reason = listenFailure {
            agentSetup = .cannotListen(reason)
            return false
        }
        switch HookSetup.status(.forThisMac(), appPath: Bundle.main.bundlePath) {
        case .ready: agentSetup = .hidden
        case .needsConnect: agentSetup = .needsConnect
        case .notInApplications: agentSetup = .notInApplications
        case .translocated: agentSetup = .translocated
        case .failed(let reason): agentSetup = .failed(reason)
        }
        return agentSetup == .needsConnect
    }

    /// What the card's second row says in each state, on one line of the card's width.
    /// A temporary copy only turns into the real one after one more approval from macOS, so
    /// the line says so: without it, the second warning looks like another failure.
    var agentSetupLine: String {
        switch agentSetup {
        case .hidden, .needsConnect: return "Perch can't hear Claude Code or codex yet"
        case .notInApplications: return "Move Perch to Applications to connect your agents"
        case .translocated: return "Temporary copy: quit, open Perch from Applications, allow it once more"
        case .failed(let reason): return "Couldn't connect: \(reason)"
        case .cannotListen(let reason): return "Perch can't receive events (\(reason)). Right-click here, quit, and reopen it"
        case .connected(let trust):
            return trust ? "Connected. In codex, trust Perch's hooks once under /hooks"
                         : "Connected. Your agents will show up here"
        }
    }

    /// The Connect button's action. With `disconnectAgents` below, the only places the app
    /// writes into another tool's configuration.
    func connectAgents() {
        do {
            let report = try HookSetup.connect(.forThisMac())
            agentSetup = .connected(codexNeedsTrust: report.codexNeedsTrust)
        } catch {
            agentSetup = .failed("\(error)")
        }
    }

    /// The menu's Disconnect Agents. Afterwards the card's second row offers Connect again.
    @discardableResult
    func disconnectAgents() throws -> HookSetup.DisconnectReport {
        let report = try HookSetup.disconnect(.forThisMac())
        refreshAgentSetup()
        return report
    }
}
