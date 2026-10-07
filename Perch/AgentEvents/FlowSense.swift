import Foundation

/// In flow, or not. There is no third answer: the levels in between only mark
/// a crossing between the two (see `Transition`).
///
/// The raw values are the wire format of the corrections file, which the three
/// provisional numbers are meant to be fitted against one day. They are a
/// contract with that future reader, so do not rename them.
enum FlowVerdict: String {
    case inFlow = "in_flow"
    case notInFlow = "not_in_flow"

    init(_ inFlow: Bool) { self = inFlow ? .inFlow : .notInFlow }
}

/// In flow right now, and what the wave should look like while saying so.
///
/// Pure functions with no I/O, so a test can compile this file alone and check
/// the judgment without an island, a log file, or a real clock.
///
/// It judges on the pickup delay: an agent really finished, and how long until
/// the next turn was set to work. It ignores what is on the screen on purpose;
/// a judgment that read looking something up as being away would convict every
/// minute of research.
///
/// The three numbers below are provisional, set by hand, to be fitted against
/// recorded corrections once there are enough of them. No fitting exists yet
/// (`FlowCorrectionLog` is written and never read), so until then the only rule
/// is that they are never nudged by hand.
enum FlowSense {
    /// The median must come in under this for the verdict to be yes.
    static let quickPickup: TimeInterval = 90

    /// How many recent pickups the verdict looks at. Fewer than this and the
    /// answer is always no: nothing has been shown yet worth claiming.
    static let window = 5

    /// A recency gate measured from the last turn start: a stretch this long
    /// with nothing set going answers no, whatever the median of the older
    /// pickups says. It is three times `quickPickup`, and as provisional as that
    /// number.
    static let dropOut: TimeInterval = 4.5 * 60

    /// How long the wave takes to cross between the two looks. The values in
    /// between exist only during the crossing.
    static let transition: TimeInterval = 0.5

    /// The wave's alpha at each end. Out of flow it fades instead of shrinking:
    /// short bars read as broken, a dim wave reads as not awake yet.
    ///
    /// `dimAlpha` assumes the island's ground is pure black. sRGB is not
    /// linear, so the same alpha emits far less light there: a short bar sits
    /// 0.0045 of luminance above black, against 0.0111 above a lifted grey.
    /// 0.23 is derived: the alpha at which a mid-height bar emits what it did
    /// on the old ground (98%).
    ///
    /// Anything that moves that ground moves this number with it; a test pins
    /// the two together.
    static let dimAlpha = 0.23
    static let fullAlpha = 1.0

    /// The wave's speed multiplier at each end, on top of whatever tempo the
    /// agent state already asked for. The slow end stays above zero on purpose:
    /// an island that stops moving looks like it crashed.
    static let slowFactor = 0.3
    static let fastFactor = 1.6

    /// The pickup delays in a set of settled turns, oldest first.
    ///
    /// Only a turn closed by a real `complete` may start one. A truncated turn's
    /// end is the last event the log saw, and an implausible turn's end sits on
    /// the far side of a sleeping machine; neither is a finish, so a delay
    /// measured from there means nothing. Either may still be landed on,
    /// because a start is always a real observed event.
    ///
    /// The same rule as `pickup_gaps()` in the daily report. The two copies are
    /// held together only by a test that feeds both the same events.
    ///
    /// Sorted by turn end, as `pickup_gaps()` is. Callers take the last five, so
    /// the order is part of the answer; if the two languages ordered
    /// differently they would judge different windows as soon as two turns
    /// overlap.
    ///
    /// A pickup delay is "the agent finished; how long until the next one was
    /// set going", so it belongs to the moment of the finish. Ordering by start
    /// would file a long-running turn as old news when its pickup just happened,
    /// and let turns that began later but finished sooner push it out of the
    /// window, which flatters the reading.
    ///
    /// Landing time (`end + gap`) is no better as a key: a slower pickup would
    /// count as more recent just for being slow, which is feedback nobody wants
    /// in a number about to be fitted.
    static func pickupGaps(_ turns: [FlowMath.Turn]) -> [TimeInterval] {
        let starts = turns.map(\.start).sorted()
        var points: [(end: Date, gap: TimeInterval)] = []
        for turn in turns {
            if turn.truncated || turn.seconds >= FlowMath.maxTurn { continue }
            guard let next = starts.first(where: { $0 > turn.end }) else { continue }
            points.append((end: turn.end, gap: next.timeIntervalSince(turn.end)))
        }
        return points.sorted { $0.end < $1.end }.map(\.gap)
    }


    /// The verdict: the median of the last `window` pickups is under
    /// `quickPickup`, and something started within `dropOut`.
    ///
    /// The two halves are independent on purpose. The median says how the work
    /// has been going, the drop-out whether it is still going at all; quick
    /// pickups half an hour ago must not keep the wave lit. Both comparisons are
    /// strict: landing exactly on a provisional threshold proves nothing.
    static func inFlow(turns: [FlowMath.Turn], now: Date) -> Bool {
        guard let lastStart = turns.map(\.start).max() else { return false }
        let sinceLastStart = now.timeIntervalSince(lastStart)
        guard sinceLastStart < dropOut else { return false }
        let gaps = pickupGaps(turns)
        guard gaps.count >= window else { return false }
        let recent = Array(gaps.suffix(window))
        return median(recent) < quickPickup
    }

    /// What was said, and what the island was saying at the time.
    ///
    /// The second field is what lets a correction end by itself. Without it
    /// there are only two ways to hold one, and both are bugs: hand the verdict
    /// straight back and the next tick overwrites it, so the switch springs back
    /// under the finger; keep it forever and one forgotten flip quietly poisons
    /// every later reading.
    ///
    /// `resolve` is the one place that decides who wins and for how long.
    struct Override: Equatable {
        let said: FlowVerdict
        let machineSaid: FlowVerdict
    }

    /// The correction wins until the situation itself changes.
    ///
    /// While the island still believes what it believed when it was corrected
    /// there is nothing new to argue with, so the correction stands. The moment
    /// it changes its mind there is evidence the correction never spoke to.
    ///
    /// The caller must keep what this hands back, not its own copy. A spent
    /// correction comes back as `nil`, and that is the only thing stopping it
    /// from reviving the next time the island returns to its first answer.
    static func resolve(auto: FlowVerdict,
                        override: Override?) -> (verdict: FlowVerdict, override: Override?) {
        guard let override else { return (auto, nil) }
        guard auto == override.machineSaid else { return (auto, nil) }   // the ground moved; the correction is spent
        return (override.said, override)
    }

    /// Median, never mean. One trip to the kettle is one number out of five,
    /// and it must not be able to drag the whole verdict along with it.
    static func median(_ values: [TimeInterval]) -> TimeInterval {
        let sorted = values.sorted()
        guard !sorted.isEmpty else { return 0 }
        let mid = sorted.count / 2
        return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }

    /// The wave's alpha for a flow level. 0 = judged out, 1 = judged in.
    static func opacity(for level: Double) -> Double {
        dimAlpha + (fullAlpha - dimAlpha) * clamped(level)
    }

    /// Multiplies whatever tempo the agent state already asked for. Flow shows
    /// through pace only; colour and height carry the agent state.
    static func tempoMultiplier(for level: Double) -> Double {
        slowFactor + (fastFactor - slowFactor) * clamped(level)
    }

    /// A level is only ever 0…1. Clamped rather than extrapolated: a caller
    /// that hands over 1.5 has a bug, and running the wave brighter than full
    /// would hide it.
    private static func clamped(_ level: Double) -> Double { min(max(level, 0), 1) }

    /// One crossing between the two looks, plus the wave's own clock across it.
    /// Held as a value because both things the wave needs, how far through the
    /// crossing it is and where its phase had got to, can only be answered
    /// relative to where the last crossing began.
    struct Transition: Equatable {
        /// Mid-crossing when a verdict flipped back before the last one finished.
        var from: Double = 0
        /// Only ever 0 or 1 in the running app: in or out, nothing to sit at.
        var to: Double = 0
        var since: Date = Date()
        /// What `waveClock` read when this crossing began. It is carried
        /// forward instead of recomputed; that is what keeps the bars from
        /// jumping when the verdict changes.
        var clockAtSince: Double = 0

        /// How far through the crossing, 0…1, eased at both ends.
        func level(at now: Date) -> Double {
            let elapsed = now.timeIntervalSince(since)
            if elapsed <= 0 { return from }
            if elapsed >= FlowSense.transition { return to }
            let x = elapsed / FlowSense.transition
            return from + (to - from) * (3 * x * x - 2 * x * x * x)   // smoothstep
        }

        /// The wave's phase clock, in seconds already scaled by the flow factor.
        ///
        /// It cannot be `now × tempoMultiplier(level)`. Bar heights are
        /// `sin(time × frequency)`, and `now` is about 8×10⁸ seconds since the
        /// reference date; multiplying that by a factor that moves every frame
        /// leaps the phase by about 10⁸ radians per frame, and the row reads as
        /// static. So the clock integrates the factor over time: the rate
        /// changes, the phase never jumps. (∫smoothstep = x³ − x⁴/2; the
        /// settled branch is that area, `transition × (a + b) / 2`, plus the
        /// straight run after it.)
        func waveClock(at now: Date) -> Double {
            let elapsed = max(0, now.timeIntervalSince(since))
            let a = FlowSense.tempoMultiplier(for: from)
            let b = FlowSense.tempoMultiplier(for: to)
            let span = FlowSense.transition
            if elapsed >= span {
                return clockAtSince + span * (a + b) / 2 + (elapsed - span) * b
            }
            let x = elapsed / span
            return clockAtSince + elapsed * a + (b - a) * span * (x * x * x - x * x * x * x / 2)
        }

        /// Aim at a new verdict from wherever the last crossing had got to, in
        /// the look and the phase both. Re-asserting the target already in force
        /// returns the crossing untouched, so a verdict that keeps agreeing with
        /// itself never restarts the fade.
        func retarget(to next: Double, at now: Date) -> Transition {
            guard next != to else { return self }
            return Transition(from: level(at: now), to: next, since: now,
                              clockAtSince: waveClock(at: now))
        }
    }
}
