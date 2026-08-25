import SwiftUI

/// The week, as a branch under a bird.
///
/// Position is the weekday: seven segments, Monday through Sunday, and the bird
/// stands on today. No letters and no dates — where the bird is tells you the
/// day, everything right of it has not happened yet, and everything left of it
/// is lit to how much of that day was spent in flow.
struct WeekPerch: View {
    let days: [DayFlow.Day]
    /// Corrections by date. A corrected day draws what it was told.
    let corrections: [String: Int]
    let today: String
    let onCorrect: (String, Int) -> Void
    /// Which day the cursor is on, so the cell beside it can say what that day
    /// reads. ⚠️ Needed because one step along `alphas` is not perceptible on a
    /// 6pt bar: the colour is the reading and must not be exaggerated to be
    /// seen, so a press confirms itself in words instead.
    let onInspect: (DayFlow.Day?) -> Void
    /// Given by the layout — see `dayWidth`.
    let width: CGFloat

    @State private var hovering: Int? = nil
    @State private var focused: Int? = nil

    /// 18 wide so a day is never narrower than the bird standing on it (15pt),
    /// 6 tall because colour needs area to be judged — a 2pt rod can only be lit
    /// or unlit, and this one has five things to say. Not private: row 1 aligns
    /// its right-hand cell on this rod's centreline.
    static let segment = CGSize(width: 18, height: 6)
    /// One day's share. Computed, not fixed: the layout sizes the branch like
    /// the wave beside it, and the seven days split whatever it is given.
    private var dayWidth: CGFloat { width / CGFloat(max(1, days.count)) }

    /// The gap between two days, cut into the PAINT and never into the wood:
    /// what reads as a progress bar is the unbroken run of coral, so the coral
    /// is what gets cut and wood is what shows through.
    ///
    /// ⚠️ Never draw this in the card's ground colour. Background punched
    /// through wood is a hole, and six holes turn the branch into seven dashes.
    static let dayGap: CGFloat = 1.5
    /// The visible branch is 6pt and nobody hits 6pt, so the hit area is 24pt
    /// and invisible. Drawn bigger instead, it reads as a progress track.
    /// ⚠️ The LAYOUT stays 24pt — the hover shape below is inset a further
    /// -8pt on every side, because drifting a few points off the wood snapped
    /// the cell back to today mid-read. Growing the frame instead would push
    /// the rows apart.
    private static let hitHeight: CGFloat = 24
    /// 20pt is the floor for this asset, not a preference — see ClosedIslandMark.
    private static let birdHeight: CGFloat = 20
    /// Measured, not guessed: PerchBird.png is 15×20.
    private static let birdWidth: CGFloat = 15

    /// The one coral every lived day is painted in. A day's LEVEL is how much of
    /// it got painted on — see `alphas`.
    static let paint = Color(red: 1.000, green: 0.800, blue: 0.720)

    /// Five levels as five opacities of that one coral.
    ///
    /// ⚠️ What the paint fades INTO is the whole question. Faded into the wood
    /// the coral loses its hue and level 1 arrives a muddy grey — a different,
    /// dirtier colour rather than the same coral, fainter. Faded into the ground
    /// the hue survives exactly. Hence `composited(level:)` and never
    /// `.opacity()`, which would blend into the wood sitting underneath.
    ///
    /// ⚠️ The 0.45 floor is measured. Fading toward black bottoms out AT black,
    /// so the low end must be held up or a lived day sinks to the unlived wood
    /// and starts claiming the day never happened. At 0.45: level 1 sits 1.89:1
    /// above the wood (danger line ≈1.5), the five span 5.70× of emitted light,
    /// smallest step 1.36.
    static let alphas: [Double] = [0.45, 0.5875, 0.725, 0.8625, 1.0]

    /// The paint at a level, already blended against the card's ground.
    private static func composited(level: Int) -> Color {
        let a = alphas[max(1, min(5, level)) - 1]
        return Color(red: 1.000 * a, green: 0.800 * a, blue: 0.720 * a)
    }

    /// A day that has not happened yet still gets a segment: "not yet" must look
    /// different from "nothing", or the week reads as broken instead of young.
    /// ⚠️ Bright, not dim — the seven have to hold together as ONE piece of wood,
    /// and what keeps an unlived day from competing with a lived one is HUE.
    /// rgb(56,56,56): clearly there, clearly not coral.
    private static let unlived = 0.22

    private var todayIndex: Int? { days.firstIndex { $0.date == today } }

    private func level(_ day: DayFlow.Day) -> Int { corrections[day.date] ?? day.level }
    private func isFuture(_ index: Int) -> Bool {
        guard let todayIndex else { return false }
        return index > todayIndex
    }

    /// Whether this day has a reading to show at all.
    ///
    /// Three ways to have none: it has not happened yet; the verdict was never
    /// answerable on it (too few pickups); or the days array is shorter than
    /// the branch. A corrected day always paints — the correction IS the
    /// reading, and it is the one case where a person outranks the measurement.
    ///
    /// ⚠️ An unjudged day drawing nothing looks like a future day, and that is
    /// the intended reading: the bird says which side of today you are on, so
    /// "left of the bird and bare" says "this happened, and nothing could be
    /// read on it" without a fourth colour nobody would learn.
    private func paints(_ index: Int) -> Bool {
        guard !isFuture(index), index < days.count else { return false }
        let day = days[index]
        return day.judged || corrections[day.date] != nil
    }

    /// One day painted onto the branch. Square where it meets its neighbours and
    /// rounded only at the branch's two ends, so it reads as wood not as pills.
    @ViewBuilder
    private func dayMark(_ index: Int, isFirst: Bool, isLast: Bool) -> some View {
        let lit = hovering == index || focused == index
        ZStack {
            if paints(index) {
                UnevenRoundedRectangle(
                    topLeadingRadius: isFirst ? Self.segment.height / 2 : 0,
                    bottomLeadingRadius: isFirst ? Self.segment.height / 2 : 0,
                    bottomTrailingRadius: isLast ? Self.segment.height / 2 : 0,
                    topTrailingRadius: isLast ? Self.segment.height / 2 : 0
                )
                .fill(tint(index))
                // The last day keeps its full width: that edge is the end of
                // the branch, not a seam between days.
                .padding(.trailing, isLast ? 0 : Self.dayGap)
            }
            // ⚠️ The cursor gets its own channel and may not touch the colour
            // underneath: that colour is the reading itself.
            if lit {
                Rectangle().fill(IslandPalette.paper.opacity(0.28))
            }
        }
    }

    /// Hue carries "did this day happen at all"; level carries how much of it.
    private func tint(_ index: Int) -> Color {
        guard paints(index) else { return IslandPalette.paper }
        return Self.composited(level: level(days[index]))
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            // ⚠️ ONE piece of wood, not seven pills: a row of short rounded
            // dashes is already a macOS shape for something else. The dim white
            // IS the branch and the coral days are painted onto it.
            Capsule()
                .fill(IslandPalette.paper.opacity(Self.unlived))
                .frame(width: width, height: Self.segment.height)
                .overlay(alignment: .leading) {
                    HStack(spacing: 0) {
                        ForEach(days.indices, id: \.self) { index in
                            dayMark(index, isFirst: index == 0,
                                    isLast: index == days.count - 1)
                                .frame(width: dayWidth, height: Self.segment.height)
                        }
                    }
                }
                // ⚠️ Nothing is drawn between two days. On a 6pt branch over
                // black there is no darker wood to draw a divider with, so days
                // are told apart by COLOUR alone — and two days at the same
                // level merging into one stretch is true, not a bug.
                .clipShape(Capsule())

            if let todayIndex {
                Image("PerchBird")
                    .renderingMode(.template)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(height: Self.birdHeight)
                    // Solid coral: the bird reports no measurement, so it has
                    // no reason to be faint, and it gives the graded branch
                    // something to be graded against.
                    .foregroundStyle(IslandPalette.cue)
                    .offset(x: CGFloat(todayIndex) * dayWidth
                                + (dayWidth - Self.birdWidth) / 2,
                            y: -Self.segment.height)
                    .allowsHitTesting(false)
            }
        }
        .frame(width: width, height: Self.hitHeight, alignment: .bottomLeading)
        .contentShape(Rectangle().inset(by: -8))
        .onContinuousHover { phase in
            switch phase {
            case .active(let point):
                hovering = index(atX: point.x)
                onInspect(hovering.map { days[$0] })
            case .ended:
                hovering = nil
                onInspect(nil)
            }
        }
        .onTapGesture { correct(hovering ?? focused) }
        .focusable()
        .onMoveCommand { direction in
            guard let count = days.indices.last else { return }
            let current = focused ?? todayIndex ?? 0
            switch direction {
            case .left:  focused = max(0, current - 1)
            case .right: focused = min(count, current + 1)
            default: break
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.spoken(days: days, corrections: corrections))
        .help("A week of flow · press a day to say it was wrong")
    }

    /// Snap to the nearest day rather than demanding a hit inside one.
    private func index(atX x: CGFloat) -> Int? {
        guard width > 0, !days.isEmpty else { return nil }
        let raw = Int(x / dayWidth)
        return min(max(0, raw), days.count - 1)
    }

    private func correct(_ index: Int?) {
        guard let index, !isFuture(index) else { return }
        let day = days[index]
        // One press walks the ladder round: saying "wrong" should not need a
        // second control to say "how wrong".
        let next = level(day) % 5 + 1
        onCorrect(day.date, next)
        onInspect(day)   // the press has to be able to announce itself

    }

    static func spoken(days: [DayFlow.Day], corrections: [String: Int]) -> String {
        days.map { day in
            "\(day.date): flow \(corrections[day.date] ?? day.level) of 5"
        }.joined(separator: ", ")
    }
}
