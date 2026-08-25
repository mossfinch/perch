import Foundation

/// How much of a day was judged in flow, as one of five levels — one segment
/// of the week perch each.
///
/// ⚠️ This judges nothing of its own. It calls `FlowSense.inFlow` at every
/// moment the verdict could change and totals the time it held, so the rule
/// stays in one place and moving a threshold there moves this too.
enum DayFlow {
    /// Minutes-in-flow at which each level begins: an eighth, a quarter, half,
    /// and three quarters of an eight-hour day. Absolute on purpose — a level
    /// means the same thing on every install, and 5/5 reads as "most of a
    /// working day in flow" without knowing whose machine this is. The metric
    /// undercounts by design (reading and deciding produce no pickups — see
    /// the header), so the top levels are earned, not decorative.
    ///
    /// ⚠️ These four are a UNIT, not a fit: they move only if the working day
    /// they are anchored to does. The verdict's three numbers (`FlowSense`)
    /// stay provisional and fitted; this ladder does not follow them.
    static let levelStarts: [TimeInterval] = [60, 120, 240, 360].map { $0 * 60 }

    /// One day's reading.
    struct Day: Equatable {
        var date: String            // yyyy-MM-dd, local, same key as DayScore
        var seconds: TimeInterval
        /// Agents' running time that day, wall clock — a DIFFERENT duration
        /// from `seconds` and named apart on screen, because the two were read
        /// as one number: working eight hours is not eight hours in flow. The
        /// branch's colour stays flow-only; this rides the cell's carousel.
        var workSeconds: TimeInterval   // time the verdict was true
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
        /// ⚠️ Defaults to false so a caller that forgets shows nothing rather
        /// than showing a level it cannot back.
        var judged: Bool = false
    }

    /// The week and whatever corrections argue with it, in one call.
    ///
    /// Both come off disk and every caller wants them together, so they are read
    /// together — and reading them here rather than in the view keeps the whole
    /// of "what does the branch show" out of the main actor's way.
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

    /// How long agents RAN that day, wall clock: the union of every turn
    /// under `maxTurn`, so parallel work counts ONCE. Summing turns instead
    /// reads as labor-hours — a day of parallel agents totalled 22h against a
    /// 12h wall — and the cell's "agents ran" is a wall-clock claim.
    /// Truncated turns included: their end is the last thing the log saw, and
    /// the work up to there really happened.
    /// ⚠️ The same spans as `run_intervals()` in the daily report, held
    /// together by a test that feeds both the same turns. Strictly under
    /// `maxTurn`, not at it.
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
    /// ⚠️ The same walk as `flow_spans()` in the daily report, and the two are
    /// compared turn for turn by a test. An instant verdict becomes a duration
    /// only where it can change, and it can change at exactly two kinds of
    /// moment: a turn STARTS — a new pickup delay has landed, so judge again —
    /// or `FlowSense.dropOut` runs out after the last start with nothing set to
    /// work. Between two starts nothing can move: a gap only becomes measurable
    /// when the next start lands on it, and time passing can only push the
    /// answer out.
    ///
    /// ⚠️ NOTHING IS BRIDGED. A silence is a break, full stop. Counting a gap
    /// as flow because it was "short enough" is the OLD measure, and it fails
    /// in the direction that flatters: it makes a break ADD time, so stepping
    /// away scores higher than working straight through.
    static func seconds(turns: [FlowMath.Turn]) -> TimeInterval {
        let starts = turns.map(\.start).sorted()
        var spans: [(start: Date, end: Date)] = []
        for (index, start) in starts.enumerated() {
            // Only what was knowable AT `start`: a turn still running has taken
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

    /// THIS week, Monday through Sunday.
    ///
    /// ⚠️ NOT the last seven days, and the difference is the whole design. Only
    /// with the seven positions fixed to Monday…Sunday does the bird's position
    /// tell you the weekday, which is what lets the branch carry no letters. A
    /// rolling window puts today at the right-hand end every day and says
    /// nothing at all.
    ///
    /// Days not yet lived come back with `seconds: 0`, flagged by falling after
    /// today in the array. `events` is injected so a test needs no container.
    static func week(now: Date = Date(),
                     calendar: Calendar = .current,
                     events: (Date, Date) -> [FlowMath.Event] = { AgentEventLog.recent(since: $0, now: $1) }) -> [Day] {
        var out: [Day] = []
        let startOfToday = calendar.startOfDay(for: now)
        // Monday = 0. ⚠️ `weekday` is 1-based with Sunday = 1 in Gregorian; a
        // locale whose week starts on Sunday must STILL get a Monday-first
        // branch, because the branch is a shape, not a calendar widget.
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
            // ⚠️ One second short of midnight, and both halves matter. The log
            // is split into one file per local day, so asking up to midnight
            // itself makes every day read and parse the NEXT day's file and
            // throw it away — measured, that was half the cost of a week. It
            // also stops an event landing exactly on midnight from being
            // counted in both days.
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
