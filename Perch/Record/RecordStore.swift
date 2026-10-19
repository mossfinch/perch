import Foundation

/// Reads the Record window's weeks off disk, newest first, without holding up the window.
///
/// A week of flow is replayed from its event files, turn by turn, and measured that takes
/// up to a second a week. So the window opens at once on what is known and fills in: this
/// week first, then one week further back at a time. A past week is kept once read, keyed
/// by the size and date of its day files, so it is read again only if one of them changed
/// (the history rebuild can still add to a past day). What is kept is also written to disk
/// (`RecordData.Cache`), so after a relaunch only this week is measured again.
@MainActor
final class RecordStore: ObservableObject {
    /// One store for the app: the cache is what makes every opening after the first instant.
    static let shared = RecordStore()

    /// Oldest first, one per week since the first day in the event log. A week not read yet
    /// is nil.
    @Published private(set) var weeks: [RecordData.Week?] = []
    /// Set when the care ledger could not be read, so the window says so instead of
    /// showing a record with no moves in it.
    @Published private(set) var ledgerProblem: String?

    private lazy var cache = RecordData.Cache.load(from: Self.cacheURL, identity: Self.identity)
    private var loading: Task<Void, Never>?
    /// Counts the loads. Cancelling a load only stops it at the next week, so a load that has
    /// been replaced checks this before it writes anything, on screen or on disk.
    private var generation = 0

    func reload(now: Date = Date()) {
        loading?.cancel()
        generation += 1
        let generation = self.generation
        let calendar = Calendar.current
        let mondays = RecordData.mondays(from: Self.firstLoggedDay() ?? now, to: now, calendar: calendar)
        let (moves, problem) = Self.moves()
        ledgerProblem = problem
        weeks = mondays.map { _ in nil }
        let cached = cache

        loading = Task.detached(priority: .userInitiated) { [weak self] in
            // Only the hand corrections: `DayFlow.read` would also measure this week, and on the
            // main thread, before the card could even draw.
            let corrections = Self.corrections()
            for index in mondays.indices.reversed() {
                if Task.isCancelled { return }
                let monday = mondays[index]
                let mondayKey = DayScore.dayFormatter.string(from: monday)
                let isCurrent = index == mondays.count - 1
                let fileKey = Self.filesKey(monday: monday, calendar: calendar)
                let readings: [RecordData.Reading]
                if !isCurrent, let hit = cached[mondayKey], hit.key == fileKey {
                    readings = hit.readings
                } else {
                    let at = RecordData.readingTime(monday: monday, now: now, calendar: calendar)
                    readings = DayFlow.week(now: at, calendar: calendar).map {
                        RecordData.Reading(date: $0.date, seconds: $0.seconds, level: $0.level,
                                           judged: $0.judged, lived: $0.date <= DayScore.dayFormatter.string(from: now))
                    }
                }
                let corrected = readings.map { reading -> RecordData.Reading in
                    var r = reading
                    if let level = corrections[r.date] { r.level = level }
                    return r
                }
                let week = RecordData.week(monday: mondayKey, readings: corrected, moves: moves, isCurrent: isCurrent)
                await MainActor.run {
                    guard let self, self.generation == generation, self.weeks.indices.contains(index) else { return }
                    self.weeks[index] = week
                    if !isCurrent { self.cache[mondayKey] = .init(key: fileKey, readings: readings) }
                }
            }
            // Written once, after the last week: one small file, and only when something new was measured.
            let measured = await MainActor.run { () -> [String: RecordData.Cache.Week]? in
                guard let self, self.generation == generation else { return nil }
                return self.cache
            }
            if let measured, measured != cached, !Task.isCancelled {
                RecordData.Cache.save(measured, identity: Self.identity, to: Self.cacheURL)
            }
        }
    }

    nonisolated private static var cacheURL: URL {
        DataHome.url.appendingPathComponent("record-cache.json")
    }

    nonisolated private static var identity: String {
        RecordData.Cache.identity(build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?",
                                  timeZone: TimeZone.current.identifier)
    }

    /// The levels corrected by hand, by day: the same answers `DayFlow.read` hands the card.
    nonisolated private static func corrections() -> [String: Int] {
        var said: [String: Int] = [:]
        for (date, answers) in DayScore.scores() {
            if let flow = answers.flow { said[date] = flow }
        }
        return said
    }

    /// The earliest day file in the event log, or nil when there is none yet.
    nonisolated private static func firstLoggedDay() -> Date? {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: eventsDirectory.path)) ?? []
        let first = names.filter { $0.hasSuffix(".jsonl") }.map { String($0.dropLast(6)) }.sorted().first
        return first.flatMap { DayScore.dayFormatter.date(from: $0) }
    }

    nonisolated private static var eventsDirectory: URL {
        DataHome.url.appendingPathComponent("agent-events")
    }

    /// What a past week's reading depends on: the size and date of each of its day files.
    nonisolated private static func filesKey(monday: Date, calendar: Calendar) -> String {
        (0..<7).map { offset -> String in
            guard let day = calendar.date(byAdding: .day, value: offset, to: monday) else { return "-" }
            let path = eventsDirectory.appendingPathComponent(DayScore.dayFormatter.string(from: day) + ".jsonl").path
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else { return "-" }
            let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
            let date = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            return "\(size)@\(date)"
        }.joined(separator: "|")
    }

    /// The ledger's moves by day, named the way the card names them. A ledger that cannot be
    /// read returns no moves and the reason.
    private static func moves() -> ([String: [String]], String?) {
        let ledger: CareLedger
        do {
            ledger = try CareLedgerStore.load()
        } catch {
            return ([:], "Couldn't read your moves: \(error.localizedDescription)")
        }
        let names = Dictionary(CareMovePool.all.map { ($0.id, $0.name.lowercased()) }, uniquingKeysWith: { a, _ in a })
        let records = ledger.records.map { (date: $0.date, moveID: $0.moveId) }
        return (RecordData.movesByDate(records) { names[$0] ?? $0 }, nil)
    }
}
