import Foundation

/// Keeps the working, waiting and complete events the island receives, for
/// restart recovery and for the week's readings.
/// Each event is one line of JSON — original project path, source, status and
/// time — in a file named for the local date.
/// It records events and never judges flow: it can watch agent interaction, it
/// cannot prove the human was focused or even present.
/// One file per day keeps reading and cleanup inside a single day, and stops
/// one log from growing without bound.
enum AgentEventLog {
    /// The event log and the socket share the same App Group container.
    private static var directory: URL {
        AppGroup.containerURL.appendingPathComponent("agent-events")
    }

    /// Every production read and write happens on this queue, so nothing blocks
    /// the main thread and no two writes interleave into half a line.
    private static let queue = DispatchQueue(label: "io.github.mossfinch.perch.event-log")

    // `stamp` and `day` are shared instances; production code must reach them
    // through `queue`.
    // `write` stays a synchronous entry point for the real round-trip test;
    // every other production caller goes through `append`.
    // `ISO8601DateFormatter` is not Sendable while `DateFormatter` is, so only
    // `stamp` needs `nonisolated(unsafe)`; for both, production concurrency
    // safety comes from the queue.
    nonisolated(unsafe) private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        // ISO8601DateFormatter defaults to UTC while file names are built from
        // the local date; this pins both to the machine's own zone.
        f.timeZone = TimeZone.current
        return f
    }()

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// Queues one event for the disk. A failure to record never interrupts what
    /// the island is actually for.
    static func append(project: String, source: String, event: String, at date: Date = Date()) {
        queue.async { _ = write(project: project, source: source, event: event, at: date, into: directory) }
    }

    /// Writes one event synchronously into the named directory; true on
    /// success.
    /// It stays a separate entry point so the round-trip test executes the real
    /// writing path instead of building sample lines of its own.
    /// Production code must call through `append`, which is what keeps the
    /// shared formatters behind `queue`.
    @discardableResult
    static func write(project: String, source: String, event: String,
                      at date: Date, into directory: URL) -> Bool {
        do {
            let line = [
                "t": stamp.string(from: date),
                "event": event,
                "project": project,
                "source": source,
            ]
            let fileName = day.string(from: date) + ".jsonl"
            guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
                  var text = String(data: data, encoding: .utf8) else { return false }
            text += "\n"
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(fileName)
            guard let bytes = text.data(using: .utf8) else { return false }
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                // When the seek fails the handle may still sit at the start of
                // the file; writing on would overwrite the day's own records.
                guard (try? handle.seekToEnd()) != nil else { return false }
                return (try? handle.write(contentsOf: bytes)) != nil
            }
            return (try? bytes.write(to: url)) != nil
        }
    }

    /// Reads the valid events inside the closed window `since...now`, oldest
    /// first.
    /// A new process uses it to recover recent events from disk instead of
    /// waiting all over again for enough samples in memory.
    /// A file that is missing, unreadable or carrying bad lines is skipped;
    /// what a gap means is the caller's decision.
    /// `override` lets a test point at a temporary directory without touching
    /// the real App Group.
    static func recent(since: Date,
                       now: Date = Date(),
                       from override: URL? = nil) -> [FlowMath.Event] {
        guard since <= now else { return [] }
        let dir = override ?? directory
        return queue.sync {
            // Take the local date every 12 hours, so a 23- or 25-hour DST day
            // cannot be stepped over.
            var names = Set([day.string(from: since), day.string(from: now)])
            var cursor = since
            while cursor < now {
                cursor = cursor.addingTimeInterval(12 * 60 * 60)
                names.insert(day.string(from: min(cursor, now)))
            }
            var events: [FlowMath.Event] = []
            for name in names {
                let url = dir.appendingPathComponent(name + ".jsonl")
                guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
                for line in text.split(separator: "\n") {
                    guard let data = line.data(using: .utf8),
                          let row = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                          let text = row["t"], let when = stamp.date(from: text),
                          when >= since, when <= now,
                          let event = row["event"],
                          let project = row["project"],
                          let source = row["source"]
                    else { continue }
                    events.append(FlowMath.Event(time: when, event: event,
                                                 project: project, source: source))
                }
            }
            return events.sorted { $0.time < $1.time }
        }
    }
}
