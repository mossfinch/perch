import Foundation

/// The judgment layer over the raw event log: turns that all have an end.
///
/// This is the second implementation of one algorithm; `island-day-report.py`
/// holds the first. The report is a terminal tool and cannot run inside a
/// sandboxed app, and the island has to answer without spawning Python. Two
/// copies can drift, so the tests feed the same cases to both and compare turn
/// for turn. Change the meaning in both or in neither.
///
/// Pure functions with no I/O, which is what makes that comparison possible.
///
/// Turns need settling because pairing "first working after a complete" with
/// "the next complete" gets whole days wrong. An interrupted agent (Esc, a
/// closed window) leaves a turn with no `complete`, pairing welds it to the
/// next session, and a few seconds of work come out hours long, taking the
/// day's total with them.
enum FlowMath {
    /// An open turn whose conversation stays quiet this long is truncated at
    /// its last event. A complete is trusted across silence after a `working`
    /// event, since a tool can run quietly for many minutes, but not after a
    /// `waiting` one: that is a person who walked away from an approval prompt.
    ///
    /// This has to sit well beyond the usual gap between working events while
    /// an agent is going; a cut just past that gap would truncate live turns.
    /// Behaviour tests pin the boundary, not this number looking reasonable.
    static let idleCut: TimeInterval = 120

    /// A turn longer than this is implausible: the machine slept, or the
    /// session sat open overnight. Such turns did complete, so they are not
    /// open. They are left out of "how long the agents ran", because counting
    /// them paints a solid block over hours nobody worked.
    static let maxTurn: TimeInterval = 2 * 60 * 60

    /// One parsed line of the event log. `event` keeps the log's own strings
    /// instead of an enum: the log is written verbatim, and an unknown value
    /// must behave like any other non-complete event instead of failing to
    /// decode.
    struct Event {
        var time: Date
        var event: String
        var project: String
        var source: String
    }

    /// A settled turn, which always has an end. `truncated` marks turns that
    /// end at the last event the log saw instead of at a complete; downstream
    /// may count them, but never as cleanly finished.
    struct Turn: Equatable {
        var start: Date
        var end: Date
        var project: String
        var source: String
        var truncated: Bool

        var seconds: TimeInterval { end.timeIntervalSince(start) }
    }

    /// Cut the events into turns that all have an end.
    ///
    /// Grouped by (source, project): two agents in two projects are two
    /// independent conversations. Within a group:
    ///   - `complete` settles the open turn, and the silence before it counts
    ///     as work when the last event seen was `working`;
    ///   - but not when it was `waiting` and the complete came more than
    ///     `idleCut` later: that silence is an empty chair, so the turn ends at
    ///     the waiting event and is truncated;
    ///   - an open turn whose line goes quiet longer than `idleCut` is
    ///     truncated at its last event, and the event that broke the silence
    ///     opens a new turn;
    ///   - whatever is still open when the events run out is truncated too.
    ///
    /// The sort by start time is stable: turns starting in the same second keep
    /// the order their lines were first seen in, so the output can be compared
    /// with the Python side byte for byte.
    static func settle(_ events: [Event], idleCut: TimeInterval = FlowMath.idleCut) -> [Turn] {
        // First-seen order, so the tie-breaking of the sort below matches the
        // report's dict iteration.
        var order: [String] = []
        var byLine: [String: [Event]] = [:]
        var lineOf: [String: (source: String, project: String)] = [:]
        for event in events {
            // NUL separator: cannot occur in a path or an agent name, so no two
            // different (source, project) pairs collide into one key.
            let key = event.source + "\u{0}" + event.project
            if byLine[key] == nil {
                byLine[key] = []
                lineOf[key] = (event.source, event.project)
                order.append(key)
            }
            byLine[key]?.append(event)
        }

        var result: [Turn] = []
        for key in order {
            // A turn belongs to its line, not to whichever event closed it.
            guard let line = lineOf[key] else { continue }
            var start: Date?
            var last: Date?
            var lastKind: String?
            for event in byLine[key] ?? [] {
                if event.event == "complete" {
                    if let start {
                        // After `working`, the silence was a tool running
                        // quietly, so the complete is trusted whole. After
                        // `waiting` it was an empty chair: a late answer does
                        // not make those minutes work, so the turn ends where
                        // the log last saw anything.
                        if lastKind == "waiting", let seen = last,
                           event.time.timeIntervalSince(seen) > idleCut {
                            result.append(Turn(start: start, end: seen, project: line.project,
                                               source: line.source, truncated: true))
                        } else {
                            result.append(Turn(start: start, end: event.time, project: line.project,
                                               source: line.source, truncated: false))
                        }
                    }
                    start = nil
                    last = nil
                    lastKind = nil
                    continue
                }
                // The weld this layer exists to cut: a turn left open by an
                // interrupt, silent past the cutoff, must not absorb the next
                // session. Truncate at the last event and let a new turn open.
                if let open = start, let seen = last, event.time.timeIntervalSince(seen) > idleCut {
                    result.append(Turn(start: open, end: seen, project: line.project,
                                       source: line.source, truncated: true))
                    start = event.time
                } else if start == nil {
                    start = event.time
                }
                last = event.time
                lastKind = event.event
            }
            if let start, let last {
                result.append(Turn(start: start, end: last, project: line.project,
                                   source: line.source, truncated: true))
            }
        }
        return result.enumerated()
            .sorted { a, b in
                a.element.start == b.element.start ? a.offset < b.offset : a.element.start < b.element.start
            }
            .map(\.element)
    }
}
