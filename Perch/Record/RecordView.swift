import SwiftUI

/// The Record, in the card's lower half: one week drawn large, the way the top row draws
/// this week, and every week since the log began as a row of strokes underneath to choose
/// from.
///
/// One thing is large and the rest stays quiet. The branch is the card's branch, painted by
/// the same rule (`WeekPerch.composited`), so a week looks here the way it looked on the
/// card. The sentence above it says what the branch shows; hovering a day turns it into
/// that day's reading, the same habit as hovering the card's branch.
struct RecordView: View {
    @ObservedObject var store: RecordStore
    /// Back to the move. Today's reading used to close it too, but its row is put away while
    /// the record is open.
    let onClose: () -> Void
    /// Which week is drawn large, by index into `store.weeks`. Nil follows the newest.
    @State private var chosen: Int?
    @State private var hovered: Int?
    @State private var pointerOnBack = false

    private static let secondary = IslandPalette.paper.opacity(0.42)
    private static let branchHeight: CGFloat = 14
    private static let dayGap: CGFloat = 3
    /// The top row's bird is 20pt; this one sits on a branch twice as thick and stays the same size.
    private static let birdHeight: CGFloat = 20
    private static let birdWidth: CGFloat = 15
    private static let weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    private var index: Int? {
        guard !store.weeks.isEmpty else { return nil }
        return min(chosen ?? store.weeks.count - 1, store.weeks.count - 1)
    }

    private var week: RecordData.Week? { index.flatMap { store.weeks[$0] } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(caption)
                    .font(.system(size: 11))
                    .foregroundStyle(Self.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 12)
                // A button, so VoiceOver can press it; underlined like every other word on the card
                // that does something, solid under the pointer (the pointer itself cannot change
                // here). The padding widens what can be hit; the negative padding outside gives the
                // room back, so the row stays where it was.
                Button { onClose() } label: {
                    Text("Back")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(IslandPalette.paper.opacity(0.85))
                        .underline(true, color: IslandPalette.paper.opacity(pointerOnBack ? 0.85 : 0.35))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                        .onHover { pointerOnBack = $0 }
                }
                .buttonStyle(.plain)
                .padding(.horizontal, -8)
                .padding(.vertical, -4)
            }
            Text(sentence)
                .font(.system(size: 20, weight: .light))
                .monospacedDigit()
                .foregroundStyle(IslandPalette.paper)
                .padding(.top, 2)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            // The card is taller than what the record draws. Two equal spacers share the rest,
            // so the week sits in the middle and the strokes go to the bottom instead of
            // leaving an empty band under them.
            Spacer(minLength: 12)
            branch
            moveMarks
                .padding(.top, 6)
            dayLetters
                .padding(.top, 5)
            Spacer(minLength: 14)
            timeline
                // Clear of the speaker in the corner below.
                .padding(.bottom, 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // A hover the panel never ended (the pointer leaving with the card) must not greet the
        // next opening with some old Thursday.
        .onAppear { hovered = nil }
        .onDisappear { hovered = nil }
        .onChange(of: chosen) { hovered = nil }
    }

    // MARK: Words

    private var caption: String {
        if let problem = store.ledgerProblem { return problem }
        guard let index, let monday = store.weeks[index]?.monday ?? mondayKey(at: index) else { return " " }
        guard let week, let hovered else { return Self.weekSpan(monday) }
        // The day and nothing else. The dots under the branch already count the moves; their
        // names ran past the card's edge and read as noise.
        return "\(Self.weekdays[hovered].prefix(3)), \(Self.shortDate(week.days[hovered].date))"
    }

    private var sentence: String {
        guard let week else { return store.weeks.isEmpty ? "Nothing logged yet" : "Reading the log…" }
        if let hovered {
            let day = week.days[hovered]
            guard day.lived else { return "Still ahead" }
            let flow = RecordData.dayFlow(day).map { $0 + " in flow" } ?? "Too little to read"
            return flow + ", " + RecordData.stretches(day.moves.count)
        }
        return RecordData.weekFlow(week.flowSeconds) + " in flow, " + RecordData.stretches(week.moveCount)
    }

    /// The store keeps weeks still being read as nil; the Monday is still known from the
    /// position, so the caption never jumps while they arrive.
    private func mondayKey(at index: Int) -> String? {
        store.weeks.compactMap { $0 }.first.flatMap { known in
            guard let knownIndex = store.weeks.firstIndex(where: { $0?.monday == known.monday }),
                  let date = DayScore.dayFormatter.date(from: known.monday),
                  let shifted = Calendar.current.date(byAdding: .day, value: 7 * (index - knownIndex), to: date)
            else { return nil }
            return DayScore.dayFormatter.string(from: shifted)
        }
    }

    /// The week from its Monday to its Sunday, the month named again only when it changes.
    private static func weekSpan(_ monday: String) -> String {
        guard let start = DayScore.dayFormatter.date(from: monday),
              let end = Calendar.current.date(byAdding: .day, value: 6, to: start) else { return monday }
        let sameMonth = Calendar.current.isDate(start, equalTo: end, toGranularity: .month)
        let last = sameMonth ? end.formatted(.dateTime.day()) : end.formatted(.dateTime.month(.abbreviated).day())
        return "\(start.formatted(.dateTime.month(.abbreviated).day())) – \(last)"
    }

    private static func shortDate(_ key: String) -> String {
        guard let date = DayScore.dayFormatter.date(from: key) else { return key }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    private static func longDate(_ key: String) -> String {
        guard let date = DayScore.dayFormatter.date(from: key) else { return key }
        return date.formatted(.dateTime.month(.wide).day())
    }

    // MARK: The week, large

    private var branch: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let dayWidth = width / 7
            ZStack(alignment: .bottomLeading) {
                Capsule()
                    .fill(IslandPalette.paper.opacity(WeekPerch.unlived))
                    .overlay(alignment: .leading) {
                        HStack(spacing: 0) {
                            ForEach(0..<7, id: \.self) { i in
                                dayMark(i)
                                    .padding(.trailing, i == 6 ? 0 : Self.dayGap)
                                    .frame(width: dayWidth, height: Self.branchHeight)
                            }
                        }
                    }
                    .clipShape(Capsule())
                    .frame(height: Self.branchHeight)
                if let bird = week?.birdIndex {
                    Image("PerchBird")
                        .renderingMode(.template)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(height: Self.birdHeight)
                        .foregroundStyle(IslandPalette.cue)
                        .offset(x: CGFloat(bird) * dayWidth + (dayWidth - Self.birdWidth) / 2, y: -Self.branchHeight)
                        .animation(.spring(response: 0.4, dampingFraction: 0.82), value: bird)
                        .allowsHitTesting(false)
                }
            }
            .frame(width: width, height: Self.branchHeight + Self.birdHeight, alignment: .bottomLeading)
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let point): hovered = max(0, min(6, Int(point.x / dayWidth)))
                case .ended: hovered = nil
                }
            }
        }
        .frame(height: Self.branchHeight + Self.birdHeight)
    }

    @ViewBuilder
    private func dayMark(_ i: Int) -> some View {
        if let day = week?.days[i], day.lived, day.judged {
            Rectangle()
                .fill(WeekPerch.composited(level: day.level))
                .overlay(hovered == i ? IslandPalette.paper.opacity(0.28) : .clear)
        } else {
            Rectangle()
                .fill(hovered == i ? IslandPalette.paper.opacity(0.12) : .clear)
        }
    }

    /// One small dot per move done that day, five at most: past that the day is simply full.
    private var moveMarks: some View {
        HStack(spacing: 0) {
            ForEach(0..<7, id: \.self) { i in
                HStack(spacing: 4) {
                    ForEach(0..<min(week?.days[i].moves.count ?? 0, 5), id: \.self) { _ in
                        Circle().fill(IslandPalette.paper).frame(width: 4, height: 4)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }

    private var dayLetters: some View {
        HStack(spacing: 0) {
            ForEach(Self.weekdays, id: \.self) { name in
                Text(name.prefix(3))
                    .font(.system(size: 10))
                    .foregroundStyle(Self.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: Every week, small

    // Thin strokes spread evenly over the card's whole width, however many weeks there are. At
    // a fixed spacing a short log left the right of the card empty; stretched to fill it they
    // turned into fat blocks. Each stroke sits centred in its share, its name centred under it.
    private static let strokeWidth: CGFloat = 6

    private var timeline: some View {
        let loaded = store.weeks.compactMap { $0 }
        let tallest = loaded.map(\.flowSeconds).max() ?? 0
        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .bottom, spacing: 0) {
                ForEach(store.weeks.indices, id: \.self) { i in
                    let share = tallest > 0 ? (store.weeks[i]?.flowSeconds ?? 0) / tallest : 0
                    // A button, not a tap gesture: the keyboard and VoiceOver can press it too.
                    Button { chosen = i } label: {
                        Capsule()
                            .fill(stroke(i))
                            .frame(width: Self.strokeWidth, height: store.weeks[i] == nil ? 3 : 4 + 26 * share)
                            // The whole share is pressable, not just the thin stroke.
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(store.weeks[i].map { "Week of \(Self.longDate($0.monday))" } ?? "Week still being read")
                }
            }
            .frame(height: 30, alignment: .bottom)
            monthNames
        }
    }

    /// The chosen week in the branch's paint, every other week in the branch's bare wood. The
    /// paint dimmed on black turns brown, so the others are not a fainter paint but plain grey.
    private func stroke(_ i: Int) -> Color {
        guard store.weeks[i] != nil else { return IslandPalette.paper.opacity(0.08) }
        return i == index ? WeekPerch.paint : IslandPalette.paper.opacity(WeekPerch.unlived)
    }

    /// A month's name under the first week that starts in it.
    private var monthNames: some View {
        HStack(spacing: 0) {
            ForEach(store.weeks.indices, id: \.self) { i in
                Text(monthStart(i) ?? "")
                    .font(.system(size: 10))
                    .foregroundStyle(Self.secondary)
                    .fixedSize()
                    .frame(maxWidth: .infinity)
            }
        }
    }

    /// A month's short name under the first week that starts in it. A month that begins one or
    /// two strokes before the next one gives way to it: two names that close collide.
    private func monthStart(_ i: Int) -> String? {
        guard let label = monthLabel(i) else { return nil }
        let next = (i + 1)..<min(i + 3, store.weeks.count)
        return next.contains { monthLabel($0) != nil } ? nil : label
    }

    private func monthLabel(_ i: Int) -> String? {
        guard let key = store.weeks[i]?.monday ?? mondayKey(at: i),
              let date = DayScore.dayFormatter.date(from: key) else { return nil }
        let calendar = Calendar.current
        let month = calendar.component(.month, from: date)
        if i > 0, let previous = store.weeks[i - 1]?.monday ?? mondayKey(at: i - 1),
           let before = DayScore.dayFormatter.date(from: previous),
           calendar.component(.month, from: before) == month { return nil }
        return date.formatted(.dateTime.month(.abbreviated))
    }
}
