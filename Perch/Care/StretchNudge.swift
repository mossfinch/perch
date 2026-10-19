import Foundation

/// Decides when the island asks for a break: after a long unbroken run of agent work, at the
/// next hand-off.
///
/// It sees agent activity only. "Unbroken" means the agents never went quiet long enough to
/// count as a pause; it says nothing about whether anyone left the chair. It has no timers of
/// its own. The caller refreshes it, which lets the tests run every rule directly.
struct StretchNudge {
    /// A gap longer than this is a pause, and the next work starts a new stretch. A gap of
    /// exactly this still counts as continuous, the same rule the daily report uses.
    ///
    /// The report has its own bridge constant. This one is kept apart because it answers a
    /// different question (did someone have time to stand up), and the report's may change.
    static let pause: TimeInterval = 5 * 60

    /// Shown on the card's first line and on the tab under the closed capsule. The tests check
    /// that it fits the narrower of the two.
    static let line = "stretch your wings"

    /// How long all agents must stay quiet before an open ask is dropped. A shorter silence is
    /// often someone reading at the desk, which looks the same as a break from here.
    static let away: TimeInterval = 20 * 60

    /// How long a stretch runs before the island asks for a break, until someone picks another.
    /// Chosen by hand.
    static let after: TimeInterval = 60 * 60

    /// An ask left this long before its move suggests the wait is too short, so the card offers
    /// another one after the move. Answered sooner, the reminder came at a good time and nothing
    /// is offered.
    static let slowAnswer: TimeInterval = 15 * 60

    /// How long this island waits, from the choices in `StretchInterval`. Nil never asks.
    private(set) var interval: TimeInterval? = StretchNudge.after

    struct Stretch: Equatable {
        var start: Date
        var end: Date
    }

    /// The most recent run of work in the turns, or nil if there are none. A turn joins the run
    /// if it starts within `pause` of the run's end, so parallel lines merge. Turns of
    /// `FlowMath.maxTurn` or longer are skipped: they come from a machine that slept.
    static func latest(in turns: [FlowMath.Turn]) -> Stretch? {
        var stretch: Stretch?
        for turn in turns.sorted(by: { $0.start < $1.start }) where turn.seconds < FlowMath.maxTurn {
            if let current = stretch, turn.start.timeIntervalSince(current.end) <= pause {
                stretch = Stretch(start: current.start, end: max(current.end, turn.end))
            } else {
                stretch = Stretch(start: turn.start, end: turn.end)
            }
        }
        return stretch
    }

    /// True while an ask is open: the card's first line and the tab show `line`.
    private(set) var asking = false
    /// True while the current stretch is ongoing and has run for `after` or longer.
    private(set) var due = false
    /// Set once the current stretch has been asked about or answered, so it asks once per stretch.
    private var spent = false
    /// When `spent` was set. A stretch that began before this moment and has not paused since
    /// is the same stretch, which is how a relaunch recognises it.
    private var spentAt: Date?
    /// Read back at launch and applied to the first stretch the island sees.
    private var restored: Memory?

    /// What must survive a relaunch. Without it the stretch is rebuilt from the log, found due,
    /// and asked about again at the next hand-off, though it was asked or answered already.
    struct Memory: Codable, Equatable {
        var spentAt: Date? = nil
        var askedAt: Date? = nil
        /// The last work seen, to the minute. A relaunch replays only the last two hours of log,
        /// so a longer stretch comes back with a later start; it is the same stretch as long as
        /// it reaches back to this moment.
        var seenAt: Date? = nil
    }

    var memory: Memory {
        // Only worth keeping while there is something to remember; to the minute, so a working
        // line rewrites it once a minute rather than on every refresh.
        let seen = (spent || asking) ? watched.map { Date(timeIntervalSince1970: ($0.end.timeIntervalSince1970 / 60).rounded(.down) * 60) } : nil
        return Memory(spentAt: spent ? spentAt : nil, askedAt: askedAt, seenAt: seen)
    }

    /// Call once at launch, before the first refresh.
    mutating func restore(_ memory: Memory) {
        restored = memory
    }
    /// Both nil unless an ask is open.
    private var askedAt: Date?
    private var nextPulse: Date?
    /// The stretch as the island has seen it. It can run longer than the turns show, because a
    /// line running one long tool sends no events and the turns read that time as a gap. `end`
    /// is the last moment work was seen.
    private(set) var watched: Stretch?
    /// Clock time and uptime at the previous refresh, used to tell a sleep from a late refresh.
    private var lastRefresh: Date?
    private var lastUptime: TimeInterval = 0
    /// The first refresh after the machine last slept longer than `pause`. Work before it is ignored.
    private var wokeAt: Date?

    /// Call after every event, before the event changes any line's status, and on the periodic
    /// tick. `busy` says whether a line is working. `uptime` is system awake time, which stops
    /// while the machine sleeps.
    ///
    /// Statuses only change with events, and every event refreshes first. So a line working now
    /// has been working since the previous refresh, even if this refresh came late. A sleep is
    /// the exception: when the clock moved more than `pause` past uptime, nothing in that gap
    /// counts as work. Quiet time is measured from the last work seen, so a late refresh or a
    /// sleep still counts all of it. An open ask is dropped after `away` of quiet.
    mutating func refresh(turns: [FlowMath.Turn], busy: Bool, now: Date, uptime: TimeInterval) {
        var since = now
        if let lastRefresh {
            if now.timeIntervalSince(lastRefresh) - (uptime - lastUptime) > Self.pause {
                wokeAt = now
            } else {
                since = lastRefresh
            }
        }
        lastRefresh = now
        lastUptime = uptime
        // The working line goes in before the turns. A long tool looks like a gap in the turns,
        // and that gap would otherwise start a new stretch.
        if busy { watch(Stretch(start: since, end: now)) }
        if let latest = Self.latest(in: turns) { watch(latest) }
        if let memory = restored, let current = watched {
            restored = nil
            applyRestored(memory, to: current, now: now)
        }
        let quiet = watched.map { now.timeIntervalSince($0.end) } ?? .infinity
        if quiet >= Self.away { dropAsk() }
        guard let watched, quiet <= Self.pause else {
            due = false
            return
        }
        due = interval.map { now.timeIntervalSince(watched.start) >= $0 } ?? false
    }

    /// Picks another wait. Turning the asks off also drops one that is open: an ask left on
    /// screen after "Never" would read as the choice not taking.
    mutating func setInterval(_ seconds: TimeInterval?) {
        interval = seconds
        if seconds == nil {
            dropAsk()
            due = false
        }
    }

    /// Adds work to the watched stretch. Work that starts more than `pause` after the last work
    /// seen begins a new stretch, which has not been asked about yet. The check uses the work's
    /// own times, so a short pause between two refreshes is still noticed.
    private mutating func watch(_ work: Stretch) {
        var work = work
        if let wokeAt {
            // Work from before the last sleep was never watched.
            guard work.end >= wokeAt else { return }
            work.start = max(work.start, wokeAt)
        }
        guard let current = watched else {
            watched = work
            return
        }
        if work.start.timeIntervalSince(current.end) <= Self.pause {
            watched = Stretch(start: min(current.start, work.start), end: max(current.end, work.end))
            return
        }
        if work.start.timeIntervalSince(current.end) >= Self.away { dropAsk() }
        watched = work
        spent = false
    }

    /// The same stretch picks up where it was: already asked or answered, and an ask still open
    /// stays open (the tab, the breathing) without opening the card a second time.
    private mutating func applyRestored(_ memory: Memory, to current: Stretch, now: Date) {
        if let at = memory.spentAt, current.start <= max(at, memory.seenAt ?? at) {
            spent = true
            spentAt = at
        }
        // Apart from the stretch: an ask outlives a short rest that ends its stretch, and stays
        // up until a move or twenty quiet minutes, relaunch or not.
        if let asked = memory.askedAt, now.timeIntervalSince(current.end) < Self.away {
            asking = true
            askedAt = asked
            nextPulse = now.addingTimeInterval(Self.pulseGap(asked: now.timeIntervalSince(asked)))
        }
    }

    private mutating func dropAsk() {
        asking = false
        askedAt = nil
        nextPulse = nil
    }

    /// Call when a line changes status. Returns true when the card should open to ask.
    ///
    /// Only a hand-off counts: a line that was not working starts working. Each tool an agent
    /// runs sends another `working`, and those come from the agent, not the person. It asks at
    /// the first hand-off after the stretch is due, at most once per stretch, and not while an
    /// earlier ask is open or a move is under way.
    mutating func statusChanged(from before: IslandAgentStatus?, to after: IslandAgentStatus,
                                moving: Bool, at now: Date) -> Bool {
        guard after == .working, before != .working, due, !spent, !asking, !moving else { return false }
        spent = true
        spentAt = now
        asking = true
        askedAt = now
        nextPulse = now.addingTimeInterval(Self.pulseGap(asked: 0))
        return true
    }

    /// Whether the tab should breathe now. The gaps get shorter the longer the ask goes
    /// unanswered. Each gap starts from the breath that just fired, so a late refresh shifts
    /// the schedule instead of firing several breaths at once.
    mutating func pulseDue(now: Date) -> Bool {
        guard let askedAt, let next = nextPulse, now >= next else { return false }
        nextPulse = now.addingTimeInterval(Self.pulseGap(asked: now.timeIntervalSince(askedAt)))
        return true
    }

    private static func pulseGap(asked: TimeInterval) -> TimeInterval {
        if asked < 10 * 60 { return 5 * 60 }
        if asked < 20 * 60 { return 2 * 60 }
        return 60
    }

    /// Whether a move finished now answers an ask that stood longer than `slowAnswer`. Call it
    /// before `moved()`, which closes the ask.
    func answeredSlowly(at now: Date) -> Bool {
        guard asking, let askedAt else { return false }
        return now.timeIntervalSince(askedAt) > Self.slowAnswer
    }

    /// Call when a move is finished. Once the stretch is due, a move answers it even if the card
    /// has not asked yet. A move earlier in the stretch does not count for the rest of it.
    mutating func moved(at now: Date = Date()) {
        dropAsk()
        if due, !spent {
            spent = true
            spentAt = now
        }
    }
}
