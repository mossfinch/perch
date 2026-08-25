import AppKit
import Combine
import SwiftUI

// `IslandAgentStatus` lives in AgentStatus.swift — pure Foundation, so the
// tally that drives the closed capsule can be compiled and tested on its own.

/// One agent's status dot in one project.
/// The unique key includes the source: the same directory open in Claude and
/// in codex is TWO independent lines of work — keyed by directory alone, the
/// two would fight over one dot and overwrite each other's state.
struct ProjectStatus: Identifiable, Equatable {
    let source: String         // "claude" / "codex"
    let key: String            // unique key = source + project dir
    let name: String           // display name = directory basename
    var status: IslandAgentStatus
    var updatedAt: Date
    var id: String { key }

    static func key(source: String, dir: String) -> String { "\(source)\t\(dir)" }
}

@MainActor
final class IslandViewModel: ObservableObject {
    enum CareSessionPhase: Equatable {
        case idle
        case active
        case paused
    }

    @Published var presentationPhase: IslandPresentationPhase = .closed
    @Published var agentStatus: IslandAgentStatus = .idle          // aggregate state: drives the bird + orchestration

    // Nothing here answers "is a human at the work", and nothing anywhere else
    // does either: the island judges flow from agent events alone. A second
    // signal for the stretch that judgment is blind to — thinking, reading,
    // deciding, none of which produce a handoff — would be a new design, not a
    // switch to turn back on.

    /// How the island currently judges "you are in flow", and how far through
    /// the crossing to that verdict the wave is.
    ///
    /// One value rather than a bare 0/1: the wave needs both how bright to be
    /// right now and where its phase had got to, and neither is answerable
    /// without knowing where the last crossing started. See `FlowSense`.
    @Published var flow = FlowSense.Transition()

    /// The events the verdict is read back from, settled into turns on demand.
    ///
    /// Held in memory while running, and **seeded from the log at launch**
    /// (107). It used to start empty, on the argument that a fresh launch
    /// showing "not in flow" is the conservative answer — but conservatism is
    /// for not knowing, and the island did know: the same window was on disk
    /// the whole time. Measured cost of the old behaviour: after three installs
    /// in half an hour the island sat 19.5 minutes at "not in flow" with 2 of
    /// the 5 pickups it needs, while its owner was in flow by its own rule.
    private var recentEvents: [FlowMath.Event] = []

    /// The last seven days, for the branch under the bird. Recomputed rather
    /// than stored: the machine's reading is a function of the event log and
    /// the thresholds, so moving a threshold re-reads history instead of
    /// leaving a file full of stale verdicts behind.
    @Published var week: [DayFlow.Day] = []
    /// Only the days you have argued with. A missing key means you never said
    /// anything, not that the day was quiet.
    @Published var weekCorrections: [String: Int] = [:]
    /// Which segment the bird stands on.
    @Published var todayKey: String = ""
    /// Which week read is the current one. ⚠️ Not `@Published` — nothing draws it.
    var weekGeneration = 0

    /// The island's own last answer, kept because a correction has to be filed
    /// against it. What the wave is SHOWING may already be a correction, and
    /// filing one against that would make it uncorrectable ever after.
    private var flowAuto: FlowVerdict = .notInFlow

    /// What you said about the verdict, while it still stands.
    ///
    /// ⚠️ Only ever assigned from what `FlowSense.resolve` hands back. Keeping
    /// a copy of the original here instead is the bug where one forgotten flip
    /// poisons every later reading — see the note on `resolve`.
    private var flowOverride: FlowSense.Override?

    /// The verdict has to be able to fall on its own. Nothing new starting is
    /// precisely what `FlowSense.dropOut` is about, and a refresh driven only
    /// by incoming events would never notice the silence. Well inside the
    /// 4.5-minute threshold, so the wave dims a few seconds after the deadline
    /// rather than a minute later.
    private var flowTimer: Timer?
    private static let flowTickInterval: TimeInterval = 15

    @Published var projects: [ProjectStatus] = []                  // one status dot per project
    @Published var display: IslandDisplayMetrics = .fallback
    @Published var sessionPhase: CareSessionPhase = .idle
    @Published var currentMove: CareMove = CareMovePool.all[0]
    @Published var completedReps: Int = 0
    @Published var currentFrameIndex: Int = 0
    @Published var elapsedSeconds: Int = 0

    // expanded = hover OR active session OR auto peek
    private var isHovering = false
    private var peekActive = false
    private var peekTimer: Timer?
    /// Whether a care session happened during this busy round — when
    /// everything finishes, this decides whether to auto-peek so the green
    /// light gets seen.
    private var caredThisRound = false
    private var pruneTimer: Timer?
    /// For expiry thresholds see `StalePolicy`. Deliberately NOT ONE duration
    /// constant lives here — the policy exists in exactly one place, and that
    /// place must be reachable by tests (see the note atop that file).

    private var tickTimer: Timer?
    private var careClock = CareSessionClock()
    private var pendingCareRecord: CareRecord?
    private let agentMonitor = AgentEventMonitor()
    private let completionSound: NSSound? = {
        if let url = Bundle.main.url(forResource: "CompletionChime", withExtension: "aiff") {
            return NSSound(contentsOf: url, byReference: false)   // audio from the app's own bundle; the sandbox allows that
        }
        return NSSound(named: "Funk")
    }()
    /// The frame-change tick. Side-neck and levator stretches are done with
    /// your head turned away from the screen — visual progress is useless for
    /// them; only sound keeps up.
    /// The audio is synthesized by artifacts/island-sounds/make_beat_tick.py
    /// with a fixed seed, fully reproducible.
    private let beatSound: NSSound? = {
        if let url = Bundle.main.url(forResource: "BeatTick", withExtension: "aiff") {
            return NSSound(contentsOf: url, byReference: false)
        }
        return NSSound(named: "Bottle")   // fallback: never go mute even if the resource missed the bundle
    }()

    init() {
        completionSound?.volume = 1.0
        beatSound?.volume = 1.0    // full volume: any quieter and ambient noise swallows the tick
        // ⚠️ ORDER IS CORRECTNESS: seed from the log BEFORE the monitor opens.
        // Start listening first and an event can land in memory and be read
        // back out of the log in the same breath, counting one turn twice.
        seedFlowFromLog()
        refreshWeek()
        startAgentMonitoring()
        startPruneTimer()
        startFlowTimer()
    }

    /// Pick the verdict back up where the last process left it instead of
    /// starting blind. Same window `noteForFlow` prunes to, so there is one
    /// number to explain and no second one to drift.
    private func seedFlowFromLog(now: Date = Date()) {
        recentEvents = AgentEventLog.recent(since: now.addingTimeInterval(-FlowMath.maxTurn), now: now)
        refreshFlow(now: now)
    }

    func hoverEntered() {
        // Hover does NOT clear done to idle: the leaf reads agentStatus while
        // the dots and the wave read the real projects state — clearing one
        // side alone makes them contradict each other the moment the panel
        // opens. Done exits naturally via the project's next event or stale
        // pruning.
        isHovering = true
        refreshPresentation()
    }
    func hoverExited() {
        isHovering = false
        refreshPresentation()
    }

    func selectCategory(_ category: CareCategory) {
        guard sessionPhase == .idle else { return }
        currentMove = category == currentMove.category
            ? CareMovePool.next(in: category, after: currentMove.id)
            : CareMovePool.first(in: category)
        resetCareProgress()
    }

    func startSession() {
        guard sessionPhase == .idle else { return }
        pendingCareRecord = nil
        sessionPhase = .active
        resetCareProgress()
        careClock.start(at: ProcessInfo.processInfo.systemUptime)
        startCareRefreshTimer()
        refreshPresentation()   // the panel stays open during a session
    }

    func pauseSession() {
        guard sessionPhase == .active else { return }
        let uptime = ProcessInfo.processInfo.systemUptime
        careClock.pause(at: uptime)
        updateCareSession(at: uptime)
        stopCareRefreshTimer()
        sessionPhase = .paused
        refreshPresentation()
    }

    func resumeSession() {
        guard sessionPhase == .paused, pendingCareRecord == nil else { return }
        careClock.resume(at: ProcessInfo.processInfo.systemUptime)
        sessionPhase = .active
        startCareRefreshTimer()
        refreshPresentation()
    }

    func endSession() {
        guard sessionPhase == .active || sessionPhase == .paused else { return }
        if let pendingCareRecord {
            persistCareSession(pendingCareRecord)
            return
        }

        let uptime = ProcessInfo.processInfo.systemUptime
        if sessionPhase == .active { careClock.pause(at: uptime) }
        updateCareDisplay(careClock.position(for: currentMove, at: uptime))
        let record = CareSessionRecorder.makeRecord(
            move: currentMove,
            setsCompleted: 0,
            elapsedSeconds: Int(floor(careClock.elapsed(at: uptime)))
        )
        persistCareSession(record)
    }

    private func startCareRefreshTimer() {
        stopCareRefreshTimer()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.updateCareSession(at: ProcessInfo.processInfo.systemUptime)
            }
        }
    }

    private func stopCareRefreshTimer() {
        tickTimer?.invalidate()
        tickTimer = nil
    }

    private func updateCareSession(at uptime: TimeInterval) {
        guard sessionPhase == .active else { return }
        let position = careClock.position(for: currentMove, at: uptime)
        updateCareDisplay(position)
        if position.isComplete {
            careClock.pause(at: uptime)
            let record = CareSessionRecorder.makeRecord(
                move: currentMove,
                setsCompleted: 1,
                elapsedSeconds: currentMove.seconds
            )
            persistCareSession(record, playCompletionSound: true)
        }
    }

    private func updateCareDisplay(_ position: CareSessionPosition) {
        // Tick only during an active session: pause/end also pass through
        // here and must stay silent. And only on entering a HOLD frame —
        // pass-throughs are the interval between sides, not a new move;
        // ticking on every frame change turns one rep into four scattered
        // ticks (the tick belongs to arriving at a side).
        if sessionPhase == .active,
           position.currentFrameIndex != currentFrameIndex,
           !currentMove.frames[position.currentFrameIndex].isPassThrough {
            playBeat()
        }
        elapsedSeconds = Int(floor(position.elapsed))
        currentFrameIndex = position.currentFrameIndex
        completedReps = position.completedReps
    }

    private func resetCareProgress() {
        elapsedSeconds = 0
        currentFrameIndex = 0
        completedReps = 0
    }

    private func persistCareSession(_ record: CareRecord, playCompletionSound: Bool = false) {
        stopCareRefreshTimer()
        do {
            _ = try CareLedgerStore.append(record)
            pendingCareRecord = nil
            caredThisRound = true
            sessionPhase = .idle
            resetCareProgress()
            if playCompletionSound { playChime() }
        } catch {
            pendingCareRecord = record
            sessionPhase = .paused
            // A failed save must be noticed: a text banner would sit behind
            // the notch where nobody sees it, and silently switching to
            // paused reads as "I must have hit pause myself". System beep as
            // the stopgap; a visible failure state is separate work.
            NSSound.beep()
        }
        refreshPresentation()
    }

    // MARK: - Multi-project events

    func startAgentMonitoring() {
        agentMonitor.onWorking = { [weak self] dir, src in self?.applyProjectEvent(dir, src, .working) }
        agentMonitor.onWaiting = { [weak self] dir, src in self?.applyProjectEvent(dir, src, .waiting) }
        agentMonitor.onComplete = { [weak self] dir, src in self?.applyProjectEvent(dir, src, .done) }
        agentMonitor.onReconciliation = { health, canonical in
            do {
                try SourceHealthStore.publish(health: health, canonical: canonical)
            } catch {
                return
            }
        }
        agentMonitor.start()
    }

    private func applyProjectEvent(_ dir: String, _ source: String, _ status: IslandAgentStatus) {
        // Record, never judge: one verbatim line that feeds none of the logic
        // below — remove this line and the island behaves identically.
        // Logs the raw dir (full path), not displayName, so future grouping
        // by directory stays possible.
        AgentEventLog.append(project: dir, source: source, event: status.logName)
        // Unlike the line above it, this one DOES change what is on screen:
        // it is what makes the wave a reading instead of decoration.
        // (There used to be a third line here, feeding the desktop widget's
        // summary. It left with the widget in 096.)
        noteForFlow(project: dir, source: source, event: status.logName, at: Date())
        let wasBusy = anyBusy()
        let key = ProjectStatus.key(source: source, dir: dir)
        if let idx = projects.firstIndex(where: { $0.key == key }) {
            projects[idx].status = status
            projects[idx].updatedAt = Date()
        } else {
            projects.append(ProjectStatus(source: source, key: key, name: Self.displayName(dir),
                                          status: status, updatedAt: Date()))
        }
        agentStatus = aggregateStatus()   // aggregate state for the leaf

        switch status {
        case .working:
            if !wasBusy {                 // nothing running → something running: peek once at the aggregate level
                caredThisRound = false
                peekOpen()
            }
        case .done:
            playChime()
            if !anyBusy(), caredThisRound {
                peekOpen()   // everything done and you cared this round → peek so the green gets seen
            }
        case .waiting, .idle:
            break
        }
    }

    // MARK: - Flow verdict

    private func startFlowTimer() {
        flowTimer = Timer.scheduledTimer(withTimeInterval: Self.flowTickInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refreshFlow()
                self?.refreshWeekIfDayChanged()
            }
        }
    }

    private func noteForFlow(project: String, source: String, event: String, at now: Date) {
        recentEvents.append(FlowMath.Event(time: now, event: event, project: project, source: source))
        // Anything older than the longest plausible turn cannot bear on the
        // last five pickups. Reusing that ceiling rather than inventing a
        // window of its own: one number to explain, and no second one to drift.
        recentEvents.removeAll { now.timeIntervalSince($0.time) > FlowMath.maxTurn }
        refreshFlow(now: now)
    }

    /// Ask the judgment again and, only if the answer actually moved, start the
    /// crossing. Republishing an unchanged verdict every 15 seconds would
    /// restart the fade forever and the wave would never settle.
    private func refreshFlow(now: Date = Date()) {
        let auto = FlowVerdict(FlowSense.inFlow(turns: FlowMath.settle(recentEvents), now: now))
        flowAuto = auto
        let (verdict, surviving) = FlowSense.resolve(auto: auto, override: flowOverride)
        flowOverride = surviving      // ⚠️ what comes back, never the copy we sent: this is how a correction expires
        let next = flow.retarget(to: verdict == .inFlow ? 1 : 0, at: now)
        if next != flow { flow = next }
    }

    /// You press the wave: whatever it is saying, you mean the other one.
    ///
    /// Bright wave pressed = "I was not in flow"; dim wave pressed = "I was".
    /// The correction is recorded against the ISLAND's verdict, not against
    /// what the wave was showing, so that it expires when the island changes
    /// its mind rather than the moment the wave is redrawn.
    ///
    /// Writing it down is an observer here, exactly like the event log: if the
    /// disk will not take the line, the wave still answers you.
    func correctFlow() {
        let showing: FlowVerdict = flow.to >= 0.5 ? .inFlow : .notInFlow
        let said: FlowVerdict = showing == .inFlow ? .notInFlow : .inFlow
        FlowCorrectionLog.append(said: said, machine: flowAuto)
        flowOverride = FlowSense.Override(said: said, machineSaid: flowAuto)
        refreshFlow()
    }

    private func anyBusy() -> Bool {
        projects.contains { $0.status == .working || $0.status == .waiting }
    }

    private func aggregateStatus() -> IslandAgentStatus {
        let all = projects.map { $0.status }
        if all.contains(.waiting) { return .waiting }
        if all.contains(.working) { return .working }
        if all.contains(.done) { return .done }
        return .idle
    }

    private func playBeat() {
        beatSound?.stop()   // restart even mid-tick, so no beat gets swallowed
        beatSound?.play()
    }

    private func playChime() {
        completionSound?.stop()
        if completionSound?.play() != true {
            NSSound.beep()   // fallback: if the named sound fails, the system beep guarantees something is heard
        }
    }

    static func displayName(_ key: String) -> String {
        let base = (key as NSString).lastPathComponent
        return base.isEmpty ? "?" : base
    }

    // MARK: - Stale pruning (no reliable session-end signal)

    private func startPruneTimer() {
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pruneStale() }
        }
    }

    private func pruneStale() {
        let now = Date()
        let before = projects.count
        projects.removeAll { project in
            StalePolicy.isStale(isWaiting: project.status == .waiting,
                                age: now.timeIntervalSince(project.updatedAt))
        }
        if projects.count != before { agentStatus = aggregateStatus() }
    }

    // MARK: - Presentation orchestration

    private func peekOpen() {
        peekActive = true
        refreshPresentation()
        peekTimer?.invalidate()
        peekTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.peekActive = false
                self?.refreshPresentation()
            }
        }
    }

    private func refreshPresentation() {
        let shouldOpen = isHovering || sessionPhase != .idle || peekActive
        let target: IslandPresentationPhase = shouldOpen ? .opened : .closed
        guard presentationPhase != target else { return }
        if target == .opened {
            // ⚠️ THE one place the week is made current: the one place the card
            // becomes visible. Hover is only one of four ways in.
            refreshWeek()
            withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { presentationPhase = .opened }
        } else {
            withAnimation(.smooth(duration: 0.3)) { presentationPhase = .closed }
        }
    }

}
