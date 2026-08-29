import Foundation

/// The judgment layer over the raw event log: turns that all have an end.
///
/// ⚠️ This is a SECOND implementation of one algorithm. `island-day-report.py`
/// holds the first — it is a terminal tool and cannot run inside a sandboxed
/// app, while the island has to answer for itself without spawning a python.
/// Two implementations are a standing drift hazard, so the tests feed the same
/// cases to both and compare turn for turn. Nothing here may be improved on its
/// own: change the meaning in both, or in neither.
///
/// Pure functions, no I/O, which is what makes that comparison possible.
///
/// Why turns need settling at all: pairing "first working after a complete"
/// with "the next complete" gets whole days wrong. An interrupted agent (Esc, a
/// closed window) leaves a turn with no `complete`, and pure pairing welds it to
/// the NEXT session, so a stretch of seconds comes out hours long and takes the
/// day's total with it.
enum FlowMath {
    /// An OPEN turn whose conversation stays quiet this long is truncated at
    /// its last event. A complete is trusted across silence behind a `working`
    /// event — a tool can run quietly for many minutes — but not behind a
    /// `waiting` one, which is a person who
    /// walked away from an approval prompt.
    ///
    /// ⚠️ This has to sit WELL beyond the gap between one working event and the
    /// next while an agent is going. A cut only a little past that gap would
    /// truncate live turns; the boundary itself is pinned by behaviour tests,
    /// not by this number looking reasonable.
    static let idleCut: TimeInterval = 120

    /// A turn longer than this is implausible — the machine slept, or the
    /// session sat open across a night. Such turns DID complete, so they are
    /// not "open"; they are simply excluded from "how long the agents ran",
    /// because counting them paints a solid block over hours nobody worked.
    static let maxTurn: TimeInterval = 2 * 60 * 60

    /// One line of the event log, already parsed. ⚠️ `event` keeps the log's own
    /// vocabulary rather than an enum: the log is written verbatim and an
    /// unknown value must behave like any other non-complete event, not crash a
    /// decoder.
    struct Event {
        var time: Date
        var event: String
        var project: String
        var source: String
    }

    /// A settled turn: it always has an end. `truncated` marks the ones whose
    /// end is the last thing the log SAW rather than a received complete —
    /// downstream may count them, but never as cleanly finished.
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
    /// Grouped by (source, project): two agents running in two projects in
    /// parallel are two independent conversations. Within a group:
    ///   · `complete` settles the open turn, and the silence before it counts
    ///     as work when the last event seen was `working`;
    ///   · …but not when it was `waiting` and the complete came more than
    ///     `idleCut` later — that silence is an empty chair, so the turn ends
    ///     at the waiting event and is truncated;
    ///   · an open turn whose line goes quiet longer than `idleCut` is
    ///     truncated at its last event, and the event that broke the silence
    ///     opens a new turn;
    ///   · whatever is still open when the events run out is truncated too.
    ///
    /// ⚠️ The result is sorted by start time STABLY: turns beginning in the same
    /// second keep the order their lines were first seen in, which is what makes
    /// the output comparable against the python side byte for byte.
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
            // A turn belongs to its LINE, not to whichever event closed it.
            guard let line = lineOf[key] else { continue }
            var start: Date?
            var last: Date?
            var lastKind: String?
            for event in byLine[key] ?? [] {
                if event.event == "complete" {
                    if let start {
                        // Which silence just ended? Behind `working` it is a
                        // tool running quietly, so the complete is trusted
                        // whole. Behind `waiting` it is an empty chair, and the
                        // answer whenever it came does not make those minutes
                        // work — end the turn where the log last saw anything.
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
