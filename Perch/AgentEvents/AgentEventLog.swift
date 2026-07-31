import Foundation

/// Record, never judge: append every agent event the island receives as one
/// line of JSON, verbatim, with no inference.
///
/// This one log directly answers: when did I start today, how long did each
/// agent run take, which project got the time — all counted facts that depend
/// on no threshold. Any threshold-dependent reading (say, "how much silence
/// means the human left") belongs to the readers of the log.
///
/// ⚠️ It measures "your interaction with agents", not "your focus". The island
/// cannot see the human: reading docs, sitting in a meeting, and walking away
/// all look identical in the event stream. The daily report may only claim
/// what it truly knows.
///
/// One file per day: reading a day means reading one file, deleting old days
/// is trivial; a single ever-appended file would grow without bound.
enum AgentEventLog {
    /// Same container as the socket: everything the island writes to disk
    /// stays inside its own App Group.
    private static var directory: URL {
        AppGroup.containerURL.appendingPathComponent("agent-events")
    }

    /// Serial queue: events arrive from the socket's queue and are forwarded
    /// via the main thread; writing must not occupy the main thread, and two
    /// writes must not interleave into half-lines.
    private static let queue = DispatchQueue(label: "io.github.mossfinch.perch.event-log")

    // Both formatters are touched ONLY on the serial queue above, so there is
    // no concurrent access. `ISO8601DateFormatter` is still not marked
    // Sendable; the `nonisolated(unsafe)` here is an honest declaration of
    // that fact — safety comes from the queue, not from the type system. (The
    // `DateFormatter` below IS marked Sendable in the SDK; adding
    // `nonisolated(unsafe)` there would draw a "redundant" compiler warning,
    // so it is omitted.) Recreating the formatter per call would also
    // compile, but that trades real cost for a compiler's smile.
    nonisolated(unsafe) private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]   // carries the offset, so cross-timezone reads stay correct
        // ⚠️ Must set the local time zone explicitly: ISO8601DateFormatter
        // defaults to UTC, while day-splitting uses the local zone. If the two
        // disagree, "when did I start" is off by a whole timezone offset. The
        // daily report asks about a human's day.
        f.timeZone = TimeZone.current
        return f
    }()

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f   // split days in local time: "when did I start today" is about a human's day, not a UTC day
    }()

    /// Append one line. Swallow every failure — broken observability must
    /// never affect the island's real work.
    static func append(project: String, source: String, event: String, at date: Date = Date()) {
        queue.async {
            let line = [
                "t": stamp.string(from: date),
                "event": event,
                "project": project,
                "source": source,
            ]
            let fileName = day.string(from: date) + ".jsonl"
            guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
                  var text = String(data: data, encoding: .utf8) else { return }
            text += "\n"
            let dir = directory
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(fileName)
            guard let bytes = text.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                // If seeking to the end fails, do not write: the handle still
                // sits at 0 and writing would OVERWRITE today's existing
                // lines from the top of the file.
                guard (try? handle.seekToEnd()) != nil else { return }
                try? handle.write(contentsOf: bytes)
            } else {
                try? bytes.write(to: url)   // first line of the day: the file does not exist yet
            }
        }
    }
}
