import Foundation

/// Keeps the flow verdict current, and handles correcting it.
///
/// The state (`flow`, `recentEvents`, `flowAuto`, `flowOverride`, `flowTimer`) stays on the
/// class, because an extension cannot hold stored properties.
extension IslandViewModel {
    /// Pick the verdict back up where the last process left it instead of
    /// starting blind. Same window `noteForFlow` prunes to, so there is one
    /// number to explain and no second one to drift.
    func seedFlowFromLog(now: Date = Date()) {
        recentEvents = AgentEventLog.recent(since: now.addingTimeInterval(-FlowMath.maxTurn), now: now)
        refreshFlow(now: now)
    }

    func startFlowTimer() {
        flowTimer = Timer.scheduledTimer(withTimeInterval: Self.flowTickInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refreshFlow()
                self?.refreshWeekIfDayChanged()
            }
        }
    }

    func noteForFlow(project: String, source: String, event: String, at now: Date) {
        recentEvents.append(FlowMath.Event(time: now, event: event, project: project, source: source))
        // Anything older than the longest plausible turn cannot bear on the
        // last five pickups. The same ceiling serves as the window, so there is
        // one number to explain and no second one to drift.
        recentEvents.removeAll { now.timeIntervalSince($0.time) > FlowMath.maxTurn }
        refreshFlow(now: now)
    }

    /// Ask the judgment again and, only if the answer actually moved, start the
    /// crossing. Republishing an unchanged verdict every 15 seconds would
    /// restart the fade forever and the wave would never settle.
    ///
    /// The stretch is refreshed here from the same settled turns, so the verdict and the
    /// stretch always describe the same moment.
    func refreshFlow(now: Date = Date()) {
        let turns = FlowMath.settle(recentEvents)
        let auto = FlowVerdict(FlowSense.inFlow(turns: turns, now: now))
        flowAuto = auto
        let (verdict, surviving) = FlowSense.resolve(auto: auto, override: flowOverride)
        flowOverride = surviving      // what comes back, never the copy we sent: this is how a correction expires
        let next = flow.retarget(to: verdict == .inFlow ? 1 : 0, at: now)
        if next != flow { flow = next }
        refreshStretch(turns: turns, now: now)
    }

    /// Updates the stretch. Only a working line keeps it going between events. A line waiting
    /// for approval does not: an approval nobody answers usually means nobody is there, which
    /// is how the settle layer reads a long wait too. On an event this runs before `projects`
    /// takes the new status (see `applyProjectEvent`).
    func refreshStretch(turns: [FlowMath.Turn], now: Date) {
        stretch.refresh(turns: turns, busy: projects.contains { $0.status == .working }, now: now,
                        uptime: ProcessInfo.processInfo.systemUptime)
        publishStretch()
        // The tab only shows while the card is closed; a pulse nobody can see is skipped.
        if stretch.pulseDue(now: now), presentationPhase == .closed { stretchPulse += 1 }
    }

    /// Publishes the stretch's answer only when it changes. The refresh runs every 15 seconds,
    /// and republishing the same value would redraw the views for nothing.
    func publishStretch() {
        if stretchNudge != stretch.asking { stretchNudge = stretch.asking }
    }

    /// You press the wave: whatever it is saying, you mean the other one.
    ///
    /// Bright wave pressed = "I was not in flow"; dim wave pressed = "I was".
    /// The correction is recorded against the island's own verdict, not against
    /// what the wave was showing, so it expires when the island changes its mind
    /// and not the moment the wave is redrawn.
    ///
    /// Writing it down only observes, exactly like the event log: if the disk
    /// will not take the line, the wave still answers you.
    func correctFlow() {
        let showing: FlowVerdict = flow.to >= 0.5 ? .inFlow : .notInFlow
        let said: FlowVerdict = showing == .inFlow ? .notInFlow : .inFlow
        FlowCorrectionLog.append(said: said, machine: flowAuto)
        flowOverride = FlowSense.Override(said: said, machineSaid: flowAuto)
        refreshFlow()
    }
}
