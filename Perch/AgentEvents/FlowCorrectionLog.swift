import Foundation

/// Corrections to the flow verdict.
///
/// This is the data the three numbers in `FlowSense` are meant to be fitted
/// against one day. Nothing reads it yet: the only reference is the `append`
/// in the view model, and the three numbers are provisional values set by
/// hand. Leaving them alone until then is a rule the comments state; nothing
/// in this file enforces it.
///
/// Corrections live in their own directory so the events stay exactly as
/// recorded, with each correction a note on top of a record nothing rewrites.
/// Tuning a threshold means laying what the island said beside what it was
/// told, which is impossible once judged lines and told ones are mixed. The
/// directory holds only these answers, so a line needs no field saying which
/// kind it is.
///
/// A correction that cannot be written down still takes effect. A failure to
/// record must never reach the island's actual job, so every failure here is
/// swallowed, and its only trace is a `false` return no caller should act on.
enum FlowCorrectionLog {
    private static var directory: URL {
        AppGroup.containerURL.appendingPathComponent("flow-corrections")
    }

    /// The tap arrives on the main thread, and writing must not hold it.
    private static let queue = DispatchQueue(label: "io.github.mossfinch.perch.flow-corrections")

    /// One file per local day: this records a person's day and has to line up
    /// with the event log it is read against.
    static func file(for when: Date, in directory: URL) -> URL {
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        day.timeZone = TimeZone.current
        day.locale = Locale(identifier: "en_US_POSIX")
        return directory.appendingPathComponent(day.string(from: when) + ".jsonl")
    }

    /// Fire and forget: the caller has already acted, and nothing waits on this.
    static func append(said: FlowVerdict, machine: FlowVerdict, at when: Date = Date()) {
        queue.async { _ = write(said: said, machine: machine, at: when, into: directory) }
    }

    /// Synchronous and pointed at a caller-named directory, so a test can run
    /// the real write into a temporary directory and into one that cannot be
    /// written.
    ///
    /// The formatters are built per call: a handful of presses a day does not
    /// justify a shared mutable object and the `nonisolated(unsafe)` it needs.
    @discardableResult
    static func write(said: FlowVerdict, machine: FlowVerdict,
                      at when: Date, into directory: URL) -> Bool {
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime]   // carries the offset, so a cross-timezone read stays correct
        // Set explicitly: ISO8601DateFormatter defaults to UTC, and the day
        // split above is local. Two clocks in one file would misalign every
        // correction against the stretch it corrects.
        stamp.timeZone = TimeZone.current
        let row: [String: Any] = [
            "t": stamp.string(from: when),
            "said": said.rawValue,
            "machineSaid": machine.rawValue,
        ]
        guard var data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
        else { return false }
        data.append(0x0A)   // its own line: a torn write may damage itself and nothing before it
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = file(for: when, in: directory)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            // If seeking to the end fails, do not write: the handle still sits
            // at 0, and writing would overwrite the day's earlier corrections.
            guard (try? handle.seekToEnd()) != nil else { return false }
            return (try? handle.write(contentsOf: data)) != nil
        }
        return (try? data.write(to: url)) != nil   // first correction of the day: no file yet
    }
}
