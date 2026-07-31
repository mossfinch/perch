import Foundation

enum CareSessionRecorder {
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
