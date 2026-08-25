import Foundation

/// Corrections to the flow verdict.
///
/// ⚠️ This file is what the three numbers in `FlowSense` get re-derived from,
/// and from nothing else — which is why they may not be nudged by hand in the
/// meantime.
///
/// ⚠️ A separate directory from the observations, and the separation is the
/// point: the events stay exactly as recorded and a correction is an annotation
/// on top of a record nothing rewrites. Tuning a threshold means laying what the
/// island said beside what it was told and finding where they disagree, which is
/// impossible once nobody can tell judged lines from told ones. This directory
/// holds that one question's answers and nothing else, so a line in it needs no
/// field saying which account it belongs to.
///
/// ⚠️ A correction that cannot be written down still takes effect. Broken
/// observability must never reach into the island's actual job, so every failure
/// here is swallowed and reported only as a `false` nobody must read.
enum FlowCorrectionLog {
    private static var directory: URL {
        AppGroup.containerURL.appendingPathComponent("flow-corrections")
    }

    /// Serial queue: the tap arrives on the main thread, and writing must not
    /// occupy it.
    private static let queue = DispatchQueue(label: "io.github.mossfinch.perch.flow-corrections")

    /// One file per day, named after the day in LOCAL time: this records a
    /// human's day and has to line up with the event log it is read against.
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

    /// The whole of the writing, synchronous and pointed at a caller-named
    /// directory — split out from `append` so a test can run it for real, into a
    /// temporary directory and into a path that cannot be written.
    ///
    /// The formatters are built per call rather than held as statics: a handful
    /// of presses a day is nothing worth a shared mutable object and the
    /// `nonisolated(unsafe)` that would come with it.
    @discardableResult
    static func write(said: FlowVerdict, machine: FlowVerdict,
                      at when: Date, into directory: URL) -> Bool {
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime]   // carries the offset, so a cross-timezone read stays correct
        // ⚠️ Must be set explicitly: ISO8601DateFormatter defaults to UTC while
        // the day split above is local. Two clocks in one file would misalign
        // every correction against the stretch it was correcting.
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
            // at 0 and writing would OVERWRITE the day's earlier corrections.
            guard (try? handle.seekToEnd()) != nil else { return false }
            return (try? handle.write(contentsOf: data)) != nil
        }
        return (try? data.write(to: url)) != nil   // first correction of the day: no file yet
    }
}
