import AppKit
import Combine
import SwiftUI

// `IslandAgentStatus` lives in AgentStatus.swift, which is pure Foundation, so
// the tally that drives the closed capsule can be compiled and tested alone.

/// One agent's status dot in one project. The key includes the source: the
/// same directory open in Claude and in codex is two independent lines of work,
/// and keyed by directory alone they would fight over one dot.
struct ProjectStatus: Identifiable, Equatable {
    let source: String         // "claude" / "codex"
    let key: String            // unique key = source + project dir
    let name: String           // display name = directory basename
    var status: IslandAgentStatus
    var updatedAt: Date
    /// When you opened the card while this line was finished. Cleared by every event.
    var seenAt: Date? = nil
    /// Where the agent runs (the app, and its Claude app session), from its latest event that said.
    var host: AgentHost? = nil
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

    // Nothing here answers whether a person is at the work, and nothing else
    // does either: the island judges flow from agent events alone. Covering
    // what that judgment cannot see (thinking, reading, deciding, none of which
    // produce a handoff) would need a new design.

    /// The flow verdict, and how far the wave is through the crossing to it.
    /// One value, not a bare 0/1: the wave needs both how bright to be now and
    /// where its phase had got to, and neither can be answered without knowing
    /// where the last crossing started. See `FlowSense.Transition`.
    @Published var flow = FlowSense.Transition()

    /// The events the verdict is read from, settled into turns on demand. Held
    /// in memory while running and seeded from the log at launch. Starting empty
    /// only looks cautious: the same window is on disk the whole time, and an
    /// empty start says "not in flow" until enough pickups land again, which a
    /// day with several launches pays for several times over.
    ///
    /// Updated in `IslandViewModel+Flow.swift`, like `flowAuto`, `flowOverride`
    /// and `flowTimer` below, so none of them is private.
    var recentEvents: [FlowMath.Event] = []

    /// This week, Monday to Sunday, for the branch under the bird. Recomputed,
    /// never stored: the reading is a function of the event log and the
    /// thresholds, so moving a threshold re-reads history instead of leaving a
    /// file full of stale verdicts.
    @Published var week: [DayFlow.Day] = []
    /// Only the days you have argued with. A missing key means you never said
    /// anything, not that the day was quiet.
    @Published var weekCorrections: [String: Int] = [:]
    /// Which segment the bird stands on.
    @Published var todayKey: String = ""
    /// Which week read is the current one. Not `@Published`: nothing draws it.
    var weekGeneration = 0
    /// Bumped by a correction, never by a read.
    ///
    /// A separate counter from `weekGeneration` on purpose. A read can be worth
    /// discarding for two reasons: a newer read owns the week now, or a person
    /// argued with it while it walked. Only the first makes its seven days
    /// stale. One counter cannot tell them apart, and a correction would throw
    /// away a whole week of fresh measurements along with the snapshot it
    /// actually invalidated.
    var correctionGeneration = 0

    /// The island's own last answer, kept because a correction has to be filed
    /// against it. What the wave shows may already be a correction, and
    /// filing one against that would make it uncorrectable ever after.
    var flowAuto: FlowVerdict = .notInFlow

    /// What you said about the verdict, while it still stands. Only ever
    /// assigned from what `FlowSense.resolve` hands back; keeping a copy of the
    /// original instead lets one forgotten flip poison every later reading (see
    /// `resolve`).
    var flowOverride: FlowSense.Override?

    /// The verdict has to be able to fall on its own. Nothing new starting is
    /// precisely what `FlowSense.dropOut` is about, and a refresh driven only
    /// by incoming events would never notice the silence. Well inside the
    /// 4.5-minute threshold, so the wave dims a few seconds after the deadline
    /// rather than a minute later.
    var flowTimer: Timer?
    static let flowTickInterval: TimeInterval = 15

    @Published var projects: [ProjectStatus] = []                  // one status dot per project
    /// Whether the card's lower half shows the Record instead of the move. See `IslandViewModel+Week.swift`.
    @Published var showingRecord = false
    /// Whether the second row offers to connect the agents. See `IslandViewModel+Setup.swift`.
    @Published var agentSetup: AgentSetup = .hidden
    /// Set once if the socket could not be opened; wins over whatever the hook check says,
    /// because wired hooks pushing at a socket nobody holds is still nothing heard.
    var listenFailure: String?

    /// Mirrors `stretch.asking` for the views. It is a separate published value so the
    /// 15-second refresh does not republish an unchanged answer.
    @Published var stretchNudge = false
    /// Incremented each time the card opens to ask. The card shakes when it changes.
    @Published var stretchShake = 0
    /// Bumped each time the tab under the closed capsule should breathe.
    @Published var stretchPulse = 0
    /// How long the work has run unbroken, and whether this stretch has been asked yet.
    /// Kept up to date by `refreshStretch` in `IslandViewModel+Flow.swift`.
    var stretch = StretchNudge()
    /// The picked wait in minutes, nil for never. Set through `chooseStretchInterval`.
    @Published var stretchMinutes: Int? = StretchInterval.load()
    /// Set when a move just answered a reminder that waited too long; the title then offers another wait.
    @Published var nudgeAnswered = false

    /// The island's one setting: whether the agents make a sound, finishing or waiting on
    /// you. Kept in UserDefaults so it survives a relaunch; a switch that springs back every
    /// morning reads as broken.
    ///
    /// It mutes those two only. The beat is the move's clock: side-neck and
    /// levator stretches are done with the head turned away from the screen,
    /// where only sound keeps up, so muting it would make the move undoable.
    @Published var chimeMuted: Bool = UserDefaults.standard.bool(forKey: chimeMutedKey) {
        didSet { UserDefaults.standard.set(chimeMuted, forKey: Self.chimeMutedKey) }
    }
    private static let chimeMutedKey = "chimeMuted"

    func toggleChime() { chimeMuted.toggle() }
    @Published var display: IslandDisplayMetrics = .fallback
    @Published var sessionPhase: CareSessionPhase = .idle
    @Published var currentMove: CareMove = CareMovePool.all[0]
    @Published var completedReps: Int = 0
    @Published var currentFrameIndex: Int = 0
    @Published var elapsedSeconds: Int = 0

    // expanded = hover || active session || auto peek
    private var isHovering = false
    private var peekActive = false
    private var peekTimer: Timer?
    /// Whether a care session happened during this busy round. When everything
    /// finishes, it decides whether to auto-peek so the green light gets seen.
    private var caredThisRound = false
    private var pruneTimer: Timer?
    /// Expiry thresholds live in `StalePolicy` and nowhere else: not one duration
    /// constant is kept here, so the policy stays in one place tests can reach.

    private var tickTimer: Timer?
    private var careClock = CareSessionClock()
    private var pendingCareRecord: CareRecord?
    private let agentMonitor = AgentEventMonitor()
    // The sounds are loaded in IslandViewModel+Sounds.swift.

    init() {
        // The order matters: seed from the log before the monitor opens.
        // Listening first lets an event land in memory and be read back out of
        // the log in the same breath, counting one turn twice.
        stretch.setInterval(StretchInterval.seconds(stretchMinutes))
        stretch.restore(.load())   // a relaunch must not ask again about a stretch already asked
        seedFlowFromLog()
        seedMoveFromLedger()   // the card opens on the move after the last one done
        refreshWeek()
        startAgentMonitoring()
        startPruneTimer()
        startFlowTimer()
        // A fresh download has nothing wired, and a bird that never moves explains nothing:
        // open once to show the offer. Delayed so the panel exists before it is asked to open.
        if refreshAgentSetup() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.peekOpen() }
        }
    }

    func hoverEntered() {
        // Hover does not clear done to idle: the leaf reads agentStatus while
        // the dots and the wave read the real projects state, so clearing one
        // side alone makes them contradict each other the moment the panel
        // opens. Done ends with the project's next event or stale pruning.
        isHovering = true
        markFinishedLinesSeen()
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

    /// Shows the move after the ledger's last record. Called at launch and after each move the
    /// ledger records, so Start continues through the catalog however the card was opened. A
    /// category picked by hand holds until the next move is recorded. An unreadable ledger
    /// starts at the first move. The failure still surfaces: the same file refuses the append
    /// when the move ends, and that beeps.
    private func seedMoveFromLedger() {
        let ledger = (try? CareLedgerStore.load()) ?? .empty
        currentMove = CareMovePool.next(after: ledger.records.last?.moveId)
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
        // Tick only during an active session: pause and end also pass through
        // here and must stay silent. And only on entering a hold frame:
        // pass-throughs are the interval between sides, and ticking on every
        // frame change turns one rep into four scattered ticks.
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
            let offer = stretch.answeredSlowly(at: Date()) && StretchInterval.canLengthen(stretchMinutes)
            stretch.moved()
            publishStretch()
            sessionPhase = .idle
            resetCareProgress()
            seedMoveFromLedger()   // the record just written is now the ledger's last
            if playCompletionSound { playChime() }
            if offer { nudgeAnswered = true; peekOpen(for: 8) }
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
        agentMonitor.onWorking = { [weak self] dir, src, host in self?.applyProjectEvent(dir, src, .working, host: host) }
        agentMonitor.onWaiting = { [weak self] dir, src, host in self?.applyProjectEvent(dir, src, .waiting, host: host) }
        agentMonitor.onComplete = { [weak self] dir, src, host in self?.applyProjectEvent(dir, src, .done, host: host) }
        agentMonitor.onReconciliation = { health, canonical in
            do {
                try SourceHealthStore.publish(health: health, canonical: canonical)
            } catch {
                return
            }
        }
        agentMonitor.onListenFailed = { [weak self] reason in
            guard let self else { return }
            listenFailure = reason
            agentSetup = .cannotListen(reason)
            // At launch the panel may not exist yet; same delay as the Connect offer.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.peekOpen() }
        }
        agentMonitor.start()
    }

    private func applyProjectEvent(_ dir: String, _ source: String, _ status: IslandAgentStatus, host: AgentHost? = nil) {
        // Record, never judge: nothing below reads this line. The log is read
        // back only to seed the verdict at launch and to draw the week.
        // It logs the raw dir (full path), not displayName, so grouping by
        // directory stays possible later.
        AgentEventLog.append(project: dir, source: source, event: status.logName)
        // Unlike the line above, this one changes what is on screen: it is what
        // makes the wave a reading instead of decoration.
        // This must run before `projects` changes below. The stretch treats the lines working
        // at this moment as the lines that were working since the last refresh.
        noteForFlow(project: dir, source: source, event: status.logName, at: Date())
        let wasBusy = anyBusy()
        let key = ProjectStatus.key(source: source, dir: dir)
        // The line's status before this event. Read after the update below, it would always
        // equal the new status, and no hand-off would ever be seen.
        let before = projects.first { $0.key == key }?.status
        let now = Date()
        if let idx = projects.firstIndex(where: { $0.key == key }) {
            projects[idx].status = status
            projects[idx].updatedAt = Date()
            projects[idx].seenAt = nil
            if let host { projects[idx].host = host.keepingSession(of: projects[idx].host) }
        } else {
            projects.append(ProjectStatus(source: source, key: key, name: Self.displayName(dir),
                                          status: status, updatedAt: Date(),
                                          host: host))
        }
        agentStatus = aggregateStatus()   // aggregate state for the leaf

        // After a long unbroken stretch, the next hand-off opens the card once to ask for a break.
        if stretch.statusChanged(from: before, to: status, moving: sessionPhase != .idle, at: now) {
            peekOpen()
            shakeSoon()
        }
        publishStretch()

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
        case .waiting:
            // A sound only: the card stays shut, because nothing visual nags. Once per wait,
            // so a repeated request on a line already yellow does not ring twice.
            if before != .waiting { playWaitingSound() }
        case .idle:
            break
        }
        if isHovering { markFinishedLinesSeen() }   // finished under your pointer is finished and seen
    }

    private func anyBusy() -> Bool {
        projects.contains { $0.status == .working || $0.status == .waiting }
    }

    func aggregateStatus() -> IslandAgentStatus {
        let all = projects.map { $0.status }
        if all.contains(.waiting) { return .waiting }
        if all.contains(.working) { return .working }
        if all.contains(.done) { return .done }
        return .idle
    }

    private func playBeat() {
        Self.beatSound?.stop()   // restart even mid-tick, so no beat gets swallowed
        Self.beatSound?.play()
    }

    private func playChime() {
        guard !chimeMuted else { return }   // muted means silent, not quieter
        Self.play(Self.completionSound)
    }

    private func playWaitingSound() {
        guard !chimeMuted else { return }
        Self.play(Self.waitingSound)
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

    // `pruneStale` and `markFinishedLinesSeen` are in IslandViewModel+Lines.swift.

    // MARK: - Presentation orchestration

    private func peekOpen(for seconds: TimeInterval = 3.5) {
        peekActive = true
        refreshPresentation()
        peekTimer?.invalidate()
        peekTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.peekActive = false
                self?.refreshPresentation()
            }
        }
    }

    /// Shakes the card once it is on screen. The peek has only just asked for the card, and a
    /// trigger that changes before the view exists is never seen by it.
    private func shakeSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
            self?.stretchShake += 1
        }
    }

    private func refreshPresentation() {
        let shouldOpen = isHovering || sessionPhase != .idle || peekActive
        let target: IslandPresentationPhase = shouldOpen ? .opened : .closed
        guard presentationPhase != target else { return }
        if target == .opened {
            // The week is made current here, in the one place the card becomes
            // visible. Hover is only one of four ways in.
            refreshWeek()
            refreshAgentSetup()
            withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { presentationPhase = .opened }
        } else {
            showingRecord = false   // the card always opens on the move, never on a record left open
            nudgeAnswered = false
            withAnimation(.smooth(duration: 0.3)) { presentationPhase = .closed }
        }
    }

}
