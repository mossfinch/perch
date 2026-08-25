import Foundation

/// A person's own reading of the day — the labels no sensor can produce, asked
/// on the island rather than in a terminal.
///
/// ⚠️ TWO questions, not one. A single score quietly answers both "did the day
/// hold together" (`rhythm`) and "did anything move" (`progress`), and mixed
/// together no number of days will ever calibrate anything. They stay apart on
/// disk as well as on screen.
///
/// One JSON object per line, re-answering appends, broken lines skipped.
/// ⚠️ The last line per FIELD wins, not the last line per date: a line updates
/// exactly the keys it carries, which is what lets three kinds of line share one
/// append-only file without standing on each other.
///
/// ⚠️ `island-day-report.py`'s `day_scores()` reads the same file by the same
/// rule. Two readers, one file, and only tests/island.test.js holds the ends
/// together.
enum DayScore {
    /// ⚠️ The raw value is the LEDGER KEY and is permanent. The words shown on
    /// the island live in the view, so wording can change without orphaning a
    /// single line already on disk.
    enum Field: String, CaseIterable {
        case rhythm
        case progress
        /// What the day's FLOW really was, 1…5, when the week perch got it
        /// wrong. Unlike the two above this is not a question the island asks —
        /// it is an argument with an answer already given, so it is only ever
        /// written where it disagrees.
        ///
        /// ⚠️ The machine's own reading is NOT stored here. `DayFlow` recomputes
        /// it from the event log every time, so moving a threshold re-reads
        /// history instead of leaving a file full of stale verdicts.
        case flow
    }

    /// What is known about one day. Any of the three may be missing: a day can
    /// be half-answered, and a day scored before the split carries only `legacy`.
    struct DayAnswers: Equatable {
        var rhythm: Int? = nil
        var progress: Int? = nil
        /// ⚠️ `nil` means nobody argued, NOT that the day was quiet.
        var flow: Int? = nil
        /// ⚠️ The one-number score from before the split. Kept readable, never
        /// written again, and never folded into either answer — which of the two
        /// questions it was answering is not knowable.
        var legacy: Int? = nil

        subscript(field: Field) -> Int? {
            get {
                switch field {
                case .rhythm: return rhythm
                case .progress: return progress
                case .flow: return flow
                }
            }
            set {
                switch field {
                case .rhythm: rhythm = newValue
                case .progress: progress = newValue
                case .flow: flow = newValue
                }
            }
        }

        /// ⚠️ `flow` takes no part: it is a correction, not one of the two
        /// questions, and a day nobody argued with is not an unanswered day.
        var isComplete: Bool { rhythm != nil && progress != nil }
    }

    static var fileURL: URL {
        AppGroup.containerURL.appendingPathComponent("day-scores.jsonl")
    }

    /// Which day a line is about, `yyyy-MM-dd`. ⚠️ Local time on purpose: "how
    /// did yesterday go" is a question about a human's day, not a UTC one —
    /// the same trap as in `AgentEventLog`. Every writer here keeps its own copy.
    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// Last line per FIELD wins: a line updates only the keys it carries.
    static func scores(from url: URL = fileURL) -> [String: DayAnswers] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
        var out: [String: DayAnswers] = [:]
        for line in text.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  // A half-written line must not hide every answer before it.
                  let date = row["date"] as? String else { continue }
            var answers = out[date] ?? DayAnswers()
            var carried = false
            for field in Field.allCases {
                if let value = row[field.rawValue] as? Int {
                    answers[field] = value
                    carried = true
                }
            }
            if let legacy = row["score"] as? Int {
                answers.legacy = legacy
                carried = true
            }
            // A line that names a day but answers nothing changes nothing —
            // it must not conjure an empty day into the map.
            if carried { out[date] = answers }
        }
        return out
    }

    /// Appending, not rewriting: changing your mind is itself worth keeping.
    @discardableResult
    static func record(date: String, field: Field, value: Int,
                       now: Date = Date(), to url: URL = fileURL) -> Bool {
        guard (1...5).contains(value) else { return false }
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime]
        let row: [String: Any] = ["date": date, field.rawValue: value,
                                  "at": stamp.string(from: now)]
        guard var data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
        else { return false }
        data.append(0x0A)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            guard (try? handle.seekToEnd()) != nil else { return false }
            return (try? handle.write(contentsOf: data)) != nil
        }
        return (try? data.write(to: url)) != nil
    }

    /// Which day the stars are asking about. Whole-day truth is best given at
    /// the end of the day, and the end of a day is often the next morning —
    /// "how did yesterday go" survives a night's sleep where "were you at your
    /// desk at 14:35" does not.
    static func target(now: Date, calendar: Calendar = .current,
                       answers: [String: DayAnswers]) -> (date: String, isBackfill: Bool) {
        let today = dayFormatter.string(from: now)
        guard calendar.component(.hour, from: now) < 12,
              let previous = calendar.date(byAdding: .day, value: -1, to: now)
        else { return (today, false) }
        let yesterday = dayFormatter.string(from: previous)
        // ⚠️ BOTH or it is not answered: nothing else will ever ask again.
        // (An old one-number score answers neither question.)
        return (answers[yesterday]?.isComplete ?? false) ? (today, false) : (yesterday, true)
    }
}
