import Foundation

/// The Record window's weeks, put together from readings someone else measured.
///
/// Nothing here measures anything. A day's flow comes from `DayFlow`, exactly as the card's
/// branch gets it, so a day reads the same in both places; the moves come from the care
/// ledger. This file only groups them into Monday-first weeks and decides where the bird
/// sits, which is why it is plain Foundation and compiles on its own in a test.
enum RecordData {
    struct Day: Equatable {
        /// yyyy-MM-dd, local, the same key as the event log and the ledger.
        var date: String
        var seconds: TimeInterval
        /// The level the branch paints, a hand correction already applied.
        var level: Int
        /// Whether the flow verdict could answer at all that day (see `DayFlow.Day.judged`).
        var judged: Bool
        /// False for the days of this week that have not happened yet.
        var lived: Bool
        /// The moves finished that day, by name, in the order they were done.
        var moves: [String]
    }

    struct Week: Equatable {
        /// The Monday, yyyy-MM-dd.
        var monday: String
        /// Monday to Sunday, always seven.
        var days: [Day]
        var isCurrent: Bool

        var flowSeconds: TimeInterval { days.reduce(0) { $0 + $1.seconds } }
        var moveCount: Int { days.reduce(0) { $0 + $1.moves.count } }

        /// Where the bird sits: on today in the current week, which is where it sits on the
        /// card; on a past week, on the day with the most flow, the one worth pointing at.
        /// Nowhere on a week with nothing measured.
        var birdIndex: Int? {
            if isCurrent { return days.lastIndex { $0.lived } }
            let measured = days.indices.filter { days[$0].judged && days[$0].seconds > 0 }
            return measured.max { days[$0].seconds < days[$1].seconds }
        }
    }

    /// A reading as `DayFlow` hands it over, before the moves are attached.
    struct Reading: Equatable, Codable {
        var date: String
        var seconds: TimeInterval
        var level: Int
        var judged: Bool
        var lived: Bool
    }

    /// Past weeks already measured, kept on disk so a relaunch measures only this week.
    ///
    /// Each week carries the key of its day files (size and date), so a day the history
    /// rebuild added to is measured again. The whole file belongs to one build of Perch in one
    /// time zone: an update may measure differently, and days are cut at local midnight, so a
    /// reading from the old rule or the old zone must not stand beside one from the new. Either
    /// change starts over rather than trusting anyone to clear it.
    struct Cache: Codable, Equatable {
        struct Week: Codable, Equatable {
            var key: String
            var readings: [Reading]
        }
        var identity: String
        var weeks: [String: Week]

        /// Who measured the weeks: the build and the time zone.
        static func identity(build: String, timeZone: String) -> String {
            "\(build) \(timeZone)"
        }

        /// The weeks stored under this identity, or none when the file is missing, unreadable,
        /// or from another build or zone. Losing it costs one slow opening, never a wrong reading.
        static func load(from url: URL, identity: String) -> [String: Week] {
            guard let data = try? Data(contentsOf: url),
                  let cache = try? JSONDecoder().decode(Cache.self, from: data),
                  cache.identity == identity else { return [:] }
            return cache.weeks
        }

        static func save(_ weeks: [String: Week], identity: String, to url: URL) {
            guard let data = try? JSONEncoder().encode(Cache(identity: identity, weeks: weeks)) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Every Monday from the week holding `first` to the week holding `now`, oldest first.
    static func mondays(from first: Date, to now: Date, calendar: Calendar) -> [Date] {
        guard let start = monday(of: first, calendar: calendar),
              let end = monday(of: now, calendar: calendar), start <= end else { return [] }
        var out: [Date] = []
        var cursor = start
        while cursor <= end {
            out.append(cursor)
            guard let next = calendar.date(byAdding: .day, value: 7, to: cursor) else { break }
            cursor = next
        }
        return out
    }

    /// The Monday that starts the week holding `date`. Monday-first whatever the locale,
    /// like the card's branch.
    static func monday(of date: Date, calendar: Calendar) -> Date? {
        let day = calendar.startOfDay(for: date)
        let offset = (calendar.component(.weekday, from: day) + 5) % 7
        return calendar.date(byAdding: .day, value: -offset, to: day)
    }

    /// The moment a week's reading should be taken at: now for the current week, so today
    /// stops at the present like on the card; the last second of Sunday for a past one.
    static func readingTime(monday: Date, now: Date, calendar: Calendar) -> Date {
        guard let next = calendar.date(byAdding: .day, value: 7, to: monday) else { return now }
        return next > now ? now : next.addingTimeInterval(-1)
    }

    /// Moves grouped by day, each named for a person.
    static func movesByDate(_ records: [(date: String, moveID: String)],
                            name: (String) -> String) -> [String: [String]] {
        var out: [String: [String]] = [:]
        for record in records { out[record.date, default: []].append(name(record.moveID)) }
        return out
    }

    static func week(monday: String, readings: [Reading], moves: [String: [String]],
                     isCurrent: Bool) -> Week {
        let days = readings.map {
            Day(date: $0.date, seconds: $0.seconds, level: $0.level, judged: $0.judged,
                lived: $0.lived, moves: $0.lived ? moves[$0.date] ?? [] : [])
        }
        return Week(monday: monday, days: days, isCurrent: isCurrent)
    }

    /// A week's stroke on the timeline, 0…1 of the tallest week. Nothing measured anywhere
    /// gives every week the same small stroke rather than dividing by zero.
    static func strokeHeights(_ weeks: [Week]) -> [Double] {
        let most = weeks.map(\.flowSeconds).max() ?? 0
        guard most > 0 else { return weeks.map { _ in 0 } }
        return weeks.map { $0.flowSeconds / most }
    }

    /// A week's flow as the sentence says it: whole hours, or minutes under one hour.
    static func weekFlow(_ seconds: TimeInterval) -> String {
        let minutes = Int(seconds / 60)
        if minutes < 60 { return minutes == 1 ? "1 minute" : "\(minutes) minutes" }
        let hours = Int((seconds / 3600).rounded())
        return hours == 1 ? "1 hour" : "\(hours) hours"
    }

    /// A day's flow the way the card's cell writes it (`TodayFlowCell.label` and
    /// `flowLabel`), so a day reads the same in both places: nothing for a day too thin to
    /// judge, `0m` for one that really measured zero. A test holds the two to the same rule.
    static func dayFlow(_ day: Day) -> String? {
        guard day.judged else { return nil }
        let minutes = Int(day.seconds / 60)
        return minutes < 60 ? "\(minutes)m" : "\(minutes / 60)h \(minutes % 60)m"
    }

    static func stretches(_ count: Int) -> String {
        count == 1 ? "1 stretch" : "\(count) stretches"
    }
}
