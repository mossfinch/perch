import Foundation

/// Assembles the result of one guided session into a v1 `CareLedger` record.
///
/// Callers supply the move, the whole sets completed, and the actual seconds; this type
/// fills in the local date, the write source, and the ISO8601 timestamp. It does not
/// measure time, judge whether a partial set counts, or write anything to disk.
enum CareSessionRecorder {
    /// Builds one care record.
    ///
    /// `now` supplies both the local date and the absolute timestamp, so the two fields
    /// cannot contradict each other across a date boundary. `calendar` determines the local
    /// date and its time zone, defaulting to the user's current calendar; tests and
    /// cross-time-zone conversions can pass an explicitly configured one.
    ///
    /// Negative sets or seconds are silently clamped to zero. A caller that treats negative
    /// values as an input error must validate before calling, because the returned record
    /// does not preserve that signal.
    static func makeRecord(
        move: CareMove,
        setsCompleted: Int,
        elapsedSeconds: Int,
        at now: Date = Date(),
        calendar: Calendar = .current
    ) -> CareRecord {
        CareRecord(
            date: localDayString(now, calendar: calendar),
            moveId: move.id,
            category: move.category,
            sets: max(0, setsCompleted),
            seconds: max(0, elapsedSeconds),
            source: "island",
            at: isoString(now)
        )
    }

    /// Formats a date as the ledger's local `yyyy-MM-dd`, using the given calendar.
    static func localDayString(_ date: Date, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            components.year ?? 0,
            components.month ?? 0,
            components.day ?? 0
        )
    }

    /// Formats the same instant as an ISO8601 string carrying date, time, and time zone.
    static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
