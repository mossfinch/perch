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
        case failed(String)
        case connected(codexNeedsTrust: Bool)
    }

    /// Reads only. Runs at launch and each time the card opens, so an agent installed while
    /// Perch runs is offered the next time anyone looks. Returns whether there is something
    /// to connect.
    @discardableResult
    func refreshAgentSetup() -> Bool {
        // A recording shows the island at work, not the offer.
        guard !AppGroup.isDemo else { return false }
        switch HookSetup.status(.forThisMac(), appPath: Bundle.main.bundlePath) {
        case .ready: agentSetup = .hidden
        case .needsConnect: agentSetup = .needsConnect
        case .notInApplications: agentSetup = .notInApplications
        case .failed(let reason): agentSetup = .failed(reason)
        }
        return agentSetup == .needsConnect
    }

    /// The Connect button's action, and the only place the app writes into another tool's
    /// configuration.
    func connectAgents() {
        do {
            let report = try HookSetup.connect(.forThisMac())
            agentSetup = .connected(codexNeedsTrust: report.codexNeedsTrust)
        } catch {
            agentSetup = .failed("\(error)")
        }
    }
}
