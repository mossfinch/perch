import Foundation

/// Turns one guided session's result into a v1 `CareLedger` record. It fills in the local
/// date, the source and the timestamp; timing, counting sets and writing to disk happen
/// elsewhere.
enum CareSessionRecorder {
    /// `now` supplies both the local date and the timestamp, so the two cannot contradict
    /// each other across a date boundary. `calendar` sets the local date's time zone; tests
    /// and cross-time-zone conversions pass an explicit one.
    ///
    /// Negative sets or seconds are clamped to zero. A caller that treats them as an input
    /// error must check before calling; the record does not keep that signal.
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

    static func localDayString(_ date: Date, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            components.year ?? 0,
            components.month ?? 0,
            components.day ?? 0
        )
    }

    static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
