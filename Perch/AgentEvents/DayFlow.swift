import Foundation

/// How much of a day was judged in flow, as one of five levels; each day is
/// one segment of the week perch.
///
/// This judges nothing of its own. It calls `FlowSense.inFlow` at every moment
/// the verdict could change and totals the time it held, so the rule stays in
/// one place and moving a threshold there moves this too.
enum DayFlow {
    /// Time in flow at which each level begins: an eighth, a quarter, a half
    /// and three quarters of an eight-hour day. Absolute on purpose: a level
    /// means the same thing on every install, and 5/5 reads as "most of a
    /// working day in flow" whoever's machine it is. The measure undercounts by
    /// design (reading and deciding produce no pickups), so the top levels are
    /// earned.
    ///
    /// These four follow the working day they are anchored to and nothing else.
    /// The verdict's three numbers in `FlowSense` stay provisional, to be fitted
    /// one day; this ladder does not follow them.
    static let levelStarts: [TimeInterval] = [60, 120, 240, 360].map { $0 * 60 }

    struct Day: Equatable {
        var date: String            // yyyy-MM-dd, local, same key as DayScore
        var seconds: TimeInterval
        /// Agents' running time that day, wall clock (see `workSeconds(turns:)`).
        /// A different duration from `seconds`: eight hours of work is not eight
        /// hours in flow. The branch's colour stays flow-only; this one shows in
        /// the cell's carousel.
        var workSeconds: TimeInterval
        /// 1…5. 1 is "barely there", 5 is "in it all day".
        var level: Int
        /// Whether the verdict was answerable at all that day.
        ///
        /// `seconds == 0` has two meanings and they must not look alike: a day
        /// with plenty of handoffs, none of them quick, really did measure
        /// zero; a day with fewer than `FlowSense.window` pickups was never
        /// judged, because the verdict refuses to answer on that little.
        /// Painting the second one at 1/5 says "a little flow" about a day
        /// nothing was measured on.
        ///
        /// Defaults to false so a caller that forgets shows nothing instead of
        /// a level it cannot back.
        var judged: Bool = false
    }

    /// The week and the corrections that argue with it, in one call.
    ///
    /// Both come off disk and every caller wants both, so they are read
    /// together. Reading them here instead of in the view keeps the whole of
    /// "what does the branch show" off the main actor.
    static func read(now: Date = Date()) -> (days: [Day], corrections: [String: Int]) {
        var said: [String: Int] = [:]
        for (date, answers) in DayScore.scores() {
            if let flow = answers.flow { said[date] = flow }
        }
        return (week(now: now), said)
    }

    static func level(forSeconds seconds: TimeInterval) -> Int {
        var level = 1
        for start in levelStarts where seconds >= start { level += 1 }
        return level
    }

    /// How long agents ran that day, wall clock: the union of every turn under
    /// `maxTurn`, so parallel work counts once. Summing turns reads as labour
    /// hours (a day of parallel agents totalled 22h against a 12h wall), and
    /// the cell's "agents ran" is a wall-clock claim.
    /// Truncated turns are included: their end is the last event the log saw,
    /// and the work up to there really happened.
    /// The same spans as `run_intervals()` in the daily report, held together
    /// by a test that feeds both the same turns. Strictly under `maxTurn`, not
    /// at it.
    static func workSeconds(turns: [FlowMath.Turn]) -> TimeInterval {
        let kept = turns.filter { $0.seconds < FlowMath.maxTurn }.sorted { $0.start < $1.start }
        var spans: [(start: Date, end: Date)] = []
        for turn in kept {
            if let last = spans.last, turn.start <= last.end {
                spans[spans.count - 1].end = max(last.end, turn.end)
            } else {
                spans.append((turn.start, turn.end))
            }
        }
        return spans.reduce(0) { $0 + $1.end.timeIntervalSince($1.start) }
    }

    /// Replay the verdict across one day's turns and total the time it held.
    ///
    /// The same walk as `flow_spans()` in the daily report; a test compares the
    /// two turn for turn. The verdict can change at exactly two kinds of moment:
    /// a turn starts (a new pickup delay has landed, so judge again), or
    /// `FlowSense.dropOut` runs out after the last start with nothing set to
    /// work. Between two starts nothing can move: a gap only becomes measurable
    /// when the next start lands on it, and time passing can only push the
    /// answer out.
    ///
    /// Nothing is bridged: a silence is a break. Counting a gap as flow because
    /// it was short enough fails in the direction that flatters, since a break
    /// would add time and stepping away would score higher than working
    /// straight through.
    static func seconds(turns: [FlowMath.Turn]) -> TimeInterval {
        let starts = turns.map(\.start).sorted()
        var spans: [(start: Date, end: Date)] = []
        for (index, start) in starts.enumerated() {
            // Only what was knowable at `start`: a turn still running has taken
            // off no pickup yet, so this is the same evidence the island had.
            let known = turns.filter { $0.start <= start }
            guard FlowSense.inFlow(turns: known, now: start) else { continue }
            let timeout = start.addingTimeInterval(FlowSense.dropOut)
            let end = index + 1 == starts.count ? timeout : min(starts[index + 1], timeout)
            if let last = spans.last, start <= last.end {
                spans[spans.count - 1].end = max(last.end, end)
            } else {
                spans.append((start: start, end: end))
            }
        }
        return spans.reduce(0) { $0 + $1.end.timeIntervalSince($1.start) }
    }

    /// This week, Monday through Sunday, and not the last seven days.
    ///
    /// Only with the seven positions fixed to Monday…Sunday does the bird's
    /// position tell you the weekday, which is what lets the branch carry no
    /// letters. A rolling window puts today at the right-hand end every day and
    /// says nothing at all.
    ///
    /// Days not yet lived come back with `seconds: 0`, after today in the array.
    /// `events` is injected so a test needs no container.
    static func week(now: Date = Date(),
                     calendar: Calendar = .current,
                     events: (Date, Date) -> [FlowMath.Event] = { AgentEventLog.recent(since: $0, now: $1) }) -> [Day] {
        var out: [Day] = []
        let startOfToday = calendar.startOfDay(for: now)
        // Monday = 0. `weekday` is 1-based with Sunday = 1 in Gregorian. A
        // locale whose week starts on Sunday still gets a Monday-first branch,
        // because the branch is a shape, not a calendar widget.
        let weekday = calendar.component(.weekday, from: startOfToday)
        let mondayOffset = (weekday + 5) % 7
        guard let monday = calendar.date(byAdding: .day, value: -mondayOffset, to: startOfToday)
        else { return [] }

        for index in 0..<7 {
            guard let dayStart = calendar.date(byAdding: .day, value: index, to: monday),
                  let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart)
            else { continue }
            let date = DayScore.dayFormatter.string(from: dayStart)
            if dayStart > now {
                // Not lived yet: asking for a future window would be a lie
                // about what was measured.
                out.append(Day(date: date, seconds: 0, workSeconds: 0, level: 1, judged: false))
                continue
            }
            // Today is still running: read it up to now, not to midnight.
            // Other days stop one second short of midnight, for two reasons.
            // The log has one file per local day, so asking up to midnight
            // itself makes every day read and parse the next day's file and
            // throw it away; measured, that was half the cost of a week. It
            // also stops an event exactly at midnight from counting in both
            // days.
            let turns = FlowMath.settle(events(dayStart, min(dayEnd.addingTimeInterval(-1), now)))
            let seconds = seconds(turns: turns)
            // The same bar the verdict itself sets: below it `inFlow` returns
            // false for lack of evidence, not because the day was slow.
            let judged = FlowSense.pickupGaps(turns).count >= FlowSense.window
            out.append(Day(date: date, seconds: seconds, workSeconds: workSeconds(turns: turns),
                           level: level(forSeconds: seconds), judged: judged))
        }
        return out
    }
}
