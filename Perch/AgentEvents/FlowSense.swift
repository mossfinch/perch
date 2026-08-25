import Foundation

/// In flow, or not. Two answers and no third: the island judges in or out, and
/// the levels in between are a crossing rather than a state (see `Transition`).
///
/// The raw values are the WIRE FORMAT of the corrections file — the one thing
/// the three provisional numbers will eventually be re-derived from — so they
/// are a contract with a future reader, not an internal name.
enum FlowVerdict: String {
    case inFlow = "in_flow"
    case notInFlow = "not_in_flow"

    init(_ inFlow: Bool) { self = inFlow ? .inFlow : .notInFlow }
}

/// In flow right now, and what the wave should look like while saying so.
///
/// Pure functions, no I/O — a test can compile this file on its own and check
/// the judgment without an island, a log file, or a real clock.
///
/// It judges on the PICKUP DELAY: an agent really finished, and then how long
/// until the next turn was set to work. It deliberately ignores what is in
/// front of the screen — a judgment that read looking something up as being
/// absent would convict every minute of research.
///
/// ⚠️ The three numbers below are provisional (n=1) and are re-derived from
/// recorded corrections, never nudged by hand.
enum FlowSense {
    /// The median must come in under this for the verdict to be yes.
    static let quickPickup: TimeInterval = 90

    /// How many recent pickups the verdict looks at. Fewer than this and the
    /// answer is always no: nothing has been shown yet worth claiming.
    static let window = 5

    /// A recency gate, not a rate: measured from the LAST turn start, so a
    /// stretch this long with nothing set going answers no whatever the median
    /// of the older pickups says. Three times `quickPickup` — a ratio, carrying
    /// the same provisional status as the number it is three times of.
    static let dropOut: TimeInterval = 4.5 * 60

    /// How long the wave takes to cross between the two looks. ⚠️ The values in
    /// between are the crossing itself, not states to rest in.
    static let transition: TimeInterval = 0.5

    /// The wave's alpha at each end. Out of flow it FADES rather than shrinks:
    /// short bars read as broken, a dim wave reads as not awake yet.
    ///
    /// ⚠️ `dimAlpha` is tied to the island's ground being PURE BLACK. sRGB is
    /// non-linear, so the same alpha emits far less light down there — a short
    /// bar sits at 0.0045 of luminance above black against 0.0111 above a
    /// lifted grey. 0.23 is derived, not dialled: the alpha at which a
    /// mid-height bar emits what it did on the old ground (98%).
    ///
    /// ⚠️ Anything that moves that ground moves this number with it. A test
    /// pins the two together.
    static let dimAlpha = 0.23
    static let fullAlpha = 1.0

    /// The wave's speed multiplier at each end, on top of whatever tempo the
    /// agent state already asked for. ⚠️ The slow end is deliberately not zero:
    /// an island that stops moving looks like it crashed.
    static let slowFactor = 0.3
    static let fastFactor = 1.6

    /// The pickup delays hiding in a set of settled turns, oldest first.
    ///
    /// ⚠️ Only a turn closed by a real `complete` may start one. A truncated
    /// turn's "end" is the last thing the log SAW, and an implausible turn's end
    /// sits on the far side of a sleeping machine; neither is a finish, so a
    /// delay measured from there measures nothing. Either may still be LANDED
    /// on — a start is always a real observed event.
    ///
    /// ⚠️ The same rule as `pickup_gaps()` in the daily report. Two
    /// implementations of one idea, held together only by a test that feeds both
    /// the same events.
    /// ⚠️ SORTED BY TURN END, and `pickup_gaps()` in the daily report sorts the
    /// same way. Callers take the LAST FIVE, so the order IS part of the answer,
    /// and it must be the same order on both sides or the two languages judge
    /// different windows the moment two turns overlap.
    ///
    /// ⚠️ End, not start. A pickup delay is "the agent finished — how long until
    /// the next one was set going", so the moment it belongs to is the FINISH.
    /// Ordering by start files a long-running turn as old news when its pickup
    /// only just happened, and lets turns that began later but finished sooner
    /// push it out of the window. Measured over 21 real days that flatters: the
    /// start order read higher on 15 of them.
    ///
    /// ⚠️ Not by landing time either, tempting as it is. That key is
    /// `end + gap`, so a slower pickup counts as more recent purely for being
    /// slow — feedback nobody wants inside a number about to be fitted.
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


    /// The verdict: median of the last `window` pickups under `quickPickup`,
    /// and something started inside `dropOut`.
    ///
    /// The two halves are independent on purpose — the median says how the work
    /// has been going, the drop-out whether it is still going at all, and a
    /// stretch of quick pickups half an hour ago must not keep the wave lit.
    /// Both comparisons are strict: landing exactly on a provisional threshold
    /// is not evidence of anything.
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
    /// ⚠️ The second field is what lets a correction end by itself. Without it
    /// there are only two ways to hold one, and both are bugs: hand the verdict
    /// straight back and the next tick overwrites it, so the switch springs back
    /// under the finger; keep it forever and one forgotten flip quietly poisons
    /// every later reading.
    ///
    /// ⚠️ One rule about who wins and for how long, in one place.
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
    /// ⚠️ The caller must keep what this hands back, not its own copy. A spent
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

    /// Multiplies whatever tempo the agent state already asked for — flow
    /// speaks through pace, never through the colour or height that carry state.
    static func tempoMultiplier(for level: Double) -> Double {
        slowFactor + (fastFactor - slowFactor) * clamped(level)
    }

    /// A level is only ever 0…1. Clamped rather than extrapolated: a caller
    /// that hands over 1.5 has a bug, and running the wave brighter than full
    /// would hide it.
    private static func clamped(_ level: Double) -> Double { min(max(level, 0), 1) }

    /// One crossing between the two looks, plus the wave's own clock across it.
    /// Held as a value because both things the wave needs — how far through the
    /// crossing, and where its phase had got to — are only answerable relative
    /// to where the last crossing began.
    struct Transition: Equatable {
        /// Mid-crossing when a verdict flipped back before the last one finished.
        var from: Double = 0
        /// Only ever 0 or 1 in the running app: in or out, nothing to sit at.
        var to: Double = 0
        var since: Date = Date()
        /// What `waveClock` read when this crossing began. ⚠️ Carried forward
        /// rather than recomputed: the one thing keeping the bars from jumping
        /// when the verdict changes.
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
        /// ⚠️ Not `now × tempoMultiplier(level)`. Bar heights are
        /// `sin(time × frequency)` and `now` is ~8×10⁸ seconds since the
        /// reference date; multiplying that by a factor that moves each frame
        /// leaps the phase by ~10⁸ radians per frame and the row reads as
        /// static. So the clock INTEGRATES the factor over time — the rate
        /// changes, the phase never jumps. (∫smoothstep = x³ − x⁴/2; the settled
        /// branch is that area, `transition × (a + b) / 2`, plus the straight
        /// run after it.)
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
