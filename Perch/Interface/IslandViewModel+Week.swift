import Foundation

/// The week under the bird: what the branch shows, and what arguing with it does.
///
/// Split out of `IslandViewModel` rather than grown inside it. The state itself
/// (`week`, `weekCorrections`, `todayKey`) has to stay on the class — `@Published`
/// cannot live in an extension — so what moved is the three things that MAINTAIN
/// it. That is the whole of "how does the branch stay true", in one place.
extension IslandViewModel {
    /// Recompute the week from the log. ⚠️ On every open, and on the tick only
    /// when the date rolled over — never from `init` alone: this is a login item
    /// that runs for days, and a week computed once puts the bird on the wrong
    /// day by morning.
    func refreshWeek(now: Date = Date()) {
        todayKey = DayScore.dayFormatter.string(from: now)   // cheap, and the rollover check reads it
        weekGeneration &+= 1
        let generation = weekGeneration
        let correctionsAt = correctionGeneration
        // ⚠️ OFF the main actor: a week of log measured ~0.8s against a real
        // history, and this runs inside the panel's own opening animation.
        Task.detached(priority: .userInitiated) {
            let read = DayFlow.read(now: now)
            await MainActor.run { [read] in
                // ⚠️ Only the newest read may publish its days. Two opens in
                // quick succession start two reads and the slower one can land
                // second with an older week — and because `todayKey` was
                // already written forward, the rollover check would never
                // correct it. Stale over fresh, permanently, with nothing on
                // screen to say so.
                guard self.weekGeneration == generation else { return }
                self.week = read.days

                // The corrections are a separate question. `DayFlow.read`
                // snapshots them BEFORE spending ~0.8s walking the week, so a
                // read that started before a press lands after it carrying a
                // snapshot that predates the press — publish that and the
                // press looks like it did nothing.
                //
                // ⚠️ But a correction changes no MEASUREMENT, so the seven days
                // above are still right and go out either way. Discarding them
                // too is how one press used to leave the other six days sitting
                // on the previous read until the card was opened again.
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

    /// A day was really this. ⚠️ The island's own reading is NOT overwritten —
    /// it is recomputed from the log every time — so the two stay side by side
    /// and the thresholds can one day be fitted against the corrections.
    func correctDay(_ date: String, _ value: Int) {
        guard DayScore.record(date: date, field: .flow, value: value) else { return }
        weekCorrections[date] = value
        // ⚠️ Invalidate the CORRECTIONS half of any read already in flight.
        // `DayFlow.read` snapshots the corrections BEFORE it spends ~0.8s
        // walking the week, so a read that started before this press lands
        // after it and would replace this answer with a snapshot that predates
        // it — the press looks like it did nothing. (The value survives on disk
        // and returns on the next open, so it reads as a dead control rather
        // than as lost data, which is worse.)
        //
        // Bumping `weekGeneration` here instead would also discard that read's
        // seven days, which no press invalidates.
        correctionGeneration &+= 1
    }
}
