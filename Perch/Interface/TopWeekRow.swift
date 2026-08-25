// Row 1 of the top band: the week's branch on the left, the matching status
// on the right.
// On hover the cell shows that day's flow and agent run time; otherwise it
// cycles today's readings and any finished project.
// Both rotations share CarouselClock, each with its own cadence and origin.
// This file only arranges the display: DayFlow supplies the data and
// CarouselClock decides the page.

import SwiftUI

/// Row 1's right-hand status cell: today's flow and agent run time, plus any
/// completion still eligible to be shown.
///
/// The flow duration and the colour level of today's segment both come from
/// `DayFlow.seconds`. The branch turns it into a colour, this cell formats it
/// as a duration; nothing is stored or recomputed here.
private struct TodayFlowCell: View {
    let week: [DayFlow.Day]
    let todayKey: String
    let projects: [ProjectStatus]
    /// The day under the cursor. While non-nil, only that day's pages show,
    /// never the resting cycle.
    let inspecting: DayFlow.Day?
    /// Levels a human corrected by hand: they replace the score on display,
    /// never the measured duration.
    let corrections: [String: Int]
    /// Origin of the resting cycle. Reset on hover-exit so the resting state
    /// starts on slot zero with today's own reading.
    /// Keyed to absolute time instead, leaving hover can land straight on a
    /// completion and the starting point becomes unpredictable.
    let carouselOrigin: Date

    private static let weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    /// Every resting slot holds the cell for the same span; a fresh completion
    /// gets no priority to cut the queue.
    /// How long a completion stays eligible is decided by the project's `.done`
    /// status and `StalePolicy`.
    /// A second lifetime here would be a second set of expiry rules.
    static let slotSeconds: TimeInterval = 30
    /// Hover pages turn in seconds; page zero shows flow first, and the rest of
    /// the durations only after a linger.
    /// 3s comes from use on the real thing: 4 dragged, 2 was too short to read.
    static let hoverSlotSeconds: TimeInterval = 3
    /// Origin of the hover pages. Reset ONLY on entering from outside the
    /// branch; sliding across days keeps the current page.
    /// Reset per day, crossing a day line snaps back to page zero and the
    /// second page becomes hard to reach.
    let inspectOrigin: Date

    /// A duration in words, or nil when there is no reading yet.
    /// With fewer than `FlowSense.window` pickups, `DayFlow.seconds` returns 0
    /// to mean "not enough samples", not "zero flow".
    /// Printing `0m` would pass missing data off as a result.
    static func label(seconds: TimeInterval) -> String? {
        guard seconds > 0 else { return nil }
        let minutes = Int(seconds / 60)
        return minutes < 60 ? "\(minutes)m" : "\(minutes / 60)h \(minutes % 60)m"
    }

    private var finished: [ProjectStatus] {
        projects.filter { $0.status == .done }.sorted { $0.updatedAt < $1.updatedAt }
    }

    /// Today's readings on the resting cycle, each duration wearing its name.
    /// The labels are what keep flow and agent run time from being read as
    /// hours worked.
    private var todayReadings: [String] {
        guard let today = week.first(where: { $0.date == todayKey }) else { return [] }
        var out: [String] = []
        if let flow = Self.label(seconds: today.seconds) { out.append("in flow \(flow)") }
        if let ran = Self.label(seconds: today.workSeconds) { out.append("agents ran \(ran)") }
        return out
    }

    /// At rest, today's readings then completions, in turn. The position is
    /// derived from the clock and never held in `@State`.
    /// Nothing to restart when the set of projects changes, and no way to skip
    /// round faster than one slot per `slotSeconds`.
    private func restingSlot(at now: Date) -> (text: String, isReading: Bool)? {
        let readings = todayReadings
        let items = finished
        let n = readings.count + items.count
        guard n > 0 else { return nil }
        let tick = CarouselClock.slot(now: now, origin: carouselOrigin,
                                      count: n, seconds: Self.slotSeconds)
        return tick < readings.count
            ? (readings[tick], true)
            : (ProjectCaption.caption(items[tick - readings.count]), false)
    }

    /// Builds the pages for the hovered day. Page zero carries that day's level
    /// and flow duration.
    /// A page for agent run time follows when there is one; with no reading at
    /// all the day answers "—".
    /// Hover content always belongs to the hovered day and may never fall back
    /// to today's resting content.
    private func inspectedPages(_ day: DayFlow.Day) -> [String] {
        guard let index = week.firstIndex(where: { $0.date == day.date }),
              index < Self.weekdays.count else { return ["—"] }
        let name = Self.weekdays[index]
        // A hand correction replaces the level on display only; the duration
        // stays the machine's measurement.
        let level = corrections[day.date] ?? day.level
        let flow: String
        if let time = Self.label(seconds: day.seconds) {
            flow = "\(name) \(level)/5 · \(time)"
        } else {
            // A corrected day still reports its corrected level even with no
            // measured duration.
            flow = corrections[day.date] != nil ? "\(name) \(level)/5" : "\(name) —"
        }
        var pages = [flow]
        if let ran = Self.label(seconds: day.workSeconds) { pages.append("\(name) agents ran \(ran)") }
        return pages
    }

    private func inspected(_ day: DayFlow.Day, at now: Date) -> String {
        let pages = inspectedPages(day)
        return pages[CarouselClock.slot(now: now, origin: inspectOrigin,
                                        count: pages.count, seconds: Self.hoverSlotSeconds)]
    }

    var body: some View {
        // A one-second grain lets the 3s hover pages turn on time; each tick
        // redraws one line of text.
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let resting = restingSlot(at: context.date)
            // Hover has strict priority: a day with nothing to say prints "—"
            // rather than today's resting content.
            let text = inspecting.map { self.inspected($0, at: context.date) } ?? resting?.text
            let tint = (inspecting == nil && resting?.isReading == false) ? IslandPalette.statusDone : IslandPalette.cue
            HStack(spacing: 6) {
                Circle()
                    .fill(tint)
                    .frame(width: 6, height: 6)
                Text(text ?? "")
                    .font(ProjectCaption.font)
                    .foregroundStyle(tint)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Hide the whole row when there is no reading today and nothing
            // finished.
            .opacity(text == nil ? 0 : 1)
        }
    }
}

/// Row 1 of the top band: the week's branch on the left, today's or the hovered
/// day's status on the right.
struct TopWeekRow: View {
    @ObservedObject var viewModel: IslandViewModel

    /// The hovered day, shared by the branch and the right-hand status cell.
    @State private var inspecting: DayFlow.Day? = nil
    /// Origin of the resting cycle; reset on hover-exit so it returns to
    /// today's readings.
    @State private var carouselOrigin = Date()
    /// Origin of the hover pages; reset only on entering from outside the
    /// branch, held across days.
    @State private var inspectOrigin = Date()

    var body: some View {
        // Bottom alignment keeps height for the bird on the branch, so the cell
        // does not float up the way centring on the full row height would.
        // The alignmentGuide then moves the right-hand text onto the branch's
        // centreline.
        HStack(alignment: .bottom, spacing: GuidedCareLayout.columnGutter) {
            GeometryReader { geo in
                WeekPerch(days: viewModel.week,
                          corrections: viewModel.weekCorrections,
                          today: viewModel.todayKey,
                          onCorrect: viewModel.correctDay,
                          onInspect: { day in
                              // Reset the resting cycle on hover-exit only;
                              // resetting on every move would pin it to slot
                              // zero.
                              if day == nil, inspecting != nil { carouselOrigin = Date() }
                              // Reset the hover pages only on entering from
                              // outside the branch. Crossing days keeps the
                              // page.
                              // Reset per day, crossing a day line returns to
                              // page zero and the second page is hard to reach.
                              if inspecting == nil, day != nil { inspectOrigin = Date() }
                              inspecting = day
                          },
                          width: geo.size.width)
            }
            TodayFlowCell(week: viewModel.week,
                          todayKey: viewModel.todayKey,
                          projects: viewModel.projects,
                          inspecting: inspecting,
                          corrections: viewModel.weekCorrections,
                          carouselOrigin: carouselOrigin,
                          inspectOrigin: inspectOrigin)
                .frame(width: GuidedCareLayout.rightColumnWidth, alignment: .leading)
                .alignmentGuide(.bottom) { d in
                    d[VerticalAlignment.center] + WeekPerch.segment.height / 2
                }
        }
    }
}
