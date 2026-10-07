import Foundation

/// The week under the bird: what the branch shows, and what arguing with it does.
///
/// The state (`week`, `weekCorrections`, `todayKey`) has to stay on the class, because
/// `@Published` cannot live in an extension. This file holds everything that keeps the
/// branch true.
extension IslandViewModel {
    /// Recompute the week from the log: on every open, and on the tick when the
    /// date rolls over. Never from `init` alone: this is a login item that runs
    /// for days, and a week computed once puts the bird on the wrong day by
    /// morning.
    func refreshWeek(now: Date = Date()) {
        todayKey = DayScore.dayFormatter.string(from: now)   // cheap, and the rollover check reads it
        weekGeneration &+= 1
        let generation = weekGeneration
        let correctionsAt = correctionGeneration
        // Off the main actor: walking a week of log takes long enough to be
        // seen, and this runs inside the panel's own opening animation.
        Task.detached(priority: .userInitiated) {
            let read = DayFlow.read(now: now)
            await MainActor.run { [read] in
                // Only the newest read may publish its days. Two quick opens
                // start two reads, and the slower one can land second with an
                // older week. `todayKey` was already written forward, so the
                // rollover check would never correct it: stale over fresh, for
                // good, with nothing on screen to say so.
                guard self.weekGeneration == generation else { return }
                self.week = read.days

                // The corrections are a separate question. `DayFlow.read`
                // snapshots them before it walks the week, so a read that
                // started before a press lands after it with a snapshot that
                // predates the press; publishing that makes the press look
                // like it did nothing.
                //
                // A correction changes no measurement, though, so the seven
                // days above are still right and go out either way.
                // Discarding them too would leave the other six days on the
                // previous read until the card was opened again.
                guard self.correctionGeneration == correctionsAt else { return }
                self.weekCorrections = read.corrections
            }
        }
    }

    /// Catch midnight while the panel is open: a string compare every tick, a
    /// week of the log at most once a day. Without it the bird stays on
    /// yesterday with nothing on screen to say so.
    func refreshWeekIfDayChanged(now: Date = Date()) {
        guard DayScore.dayFormatter.string(from: now) != todayKey else { return }
        refreshWeek(now: now)
    }

    /// A day was really this. The island's own reading is not overwritten (it is
    /// recomputed from the log every time), so the two stay side by side and the
    /// thresholds can one day be fitted against the corrections.
    func correctDay(_ date: String, _ value: Int) {
        guard DayScore.record(date: date, field: .flow, value: value) else { return }
        weekCorrections[date] = value
        // Invalidate the corrections half of any read already in flight.
        // `DayFlow.read` snapshots the corrections before it walks the week, so
        // a read that started before this press lands after it and would
        // replace this answer with an older snapshot, making the press look
        // like it did nothing. (The value survives on disk and returns on the
        // next open, so it reads as a dead control rather than as lost data,
        // which is worse.)
        //
        // Bumping `weekGeneration` here instead would also discard that read's
        // seven days, which no press invalidates.
        correctionGeneration &+= 1
    }

    /// Take back a correction: the day goes back to reading what the island
    /// measured. This cannot be a step along the ladder: a press walks 1…5 and
    /// never arrives back at "nothing said", so an argument, once started, could
    /// never be ended.
    ///
    /// Same in-flight guard as `correctDay`, for the same reason: a read that
    /// began before this lands after it, carrying corrections that predate it,
    /// and the day would silently come back.
    func clearDay(_ date: String) {
        guard weekCorrections[date] != nil else { return }
        guard DayScore.clear(date: date, field: .flow) else { return }
        weekCorrections.removeValue(forKey: date)
        correctionGeneration &+= 1
    }
}
