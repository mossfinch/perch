import Foundation

/// The working, waiting and complete events the island receives, kept for
/// restart recovery and for the week's readings.
/// Each event is one JSON line (project path, source, status, time) in a file
/// named for the local date. One file per day keeps reads and cleanup within a
/// day and stops a single log from growing without bound.
/// It records events and never judges flow: agent traffic cannot prove that a
/// person was focused, or even present.
enum AgentEventLog {
    private static var directory: URL {
        AppGroup.containerURL.appendingPathComponent("agent-events")
    }

    /// Every production read and write happens on this queue, so nothing blocks
    /// the main thread and no two writes interleave into half a line.
    private static let queue = DispatchQueue(label: "io.github.mossfinch.perch.event-log")

    // Production code reaches `stamp` and `day` only through `queue`.
    // `ISO8601DateFormatter` is not Sendable and `DateFormatter` is, so only
    // `stamp` needs `nonisolated(unsafe)`; the queue is what makes both safe.
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

    /// A failed write is ignored on purpose: recording must never get in the
    /// way of what the island is for.
    static func append(project: String, source: String, event: String, at date: Date = Date()) {
        queue.async { _ = write(project: project, source: source, event: event, at: date, into: directory) }
    }

    /// Synchronous, and separate from `append`, so the round-trip test runs the
    /// real writing path instead of building sample lines of its own.
    /// Production code calls `append`, which keeps the shared formatters behind
    /// `queue`.
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

    /// The valid events in the closed window `since...now`, oldest first.
    /// A new process reads them to recover recent events instead of waiting for
    /// enough samples in memory all over again.
    /// Missing or unreadable files and bad lines are skipped; what a gap means
    /// is for the caller to decide.
    /// `override` points a test at a temporary directory.
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
