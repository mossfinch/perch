import SwiftUI

enum GuidedCareLayout {
    static let contentHorizontalInset: CGFloat = 40   // top rows keep extra distance from the side borders
    // ⚠️ These two are traded against each other and their sum is fixed: extra
    // height for row 2 comes out of the top padding, never out of the main area,
    // so the figure strip's height is untouched.
    static let activityTopPadding: CGFloat = 14        // wave's distance from the top border
    static let activityHeight: CGFloat = 26            // the wave plus the dot row beside it
    static let activityToMainSpacing: CGFloat = 12
    /// ⚠️ Moving the figures down only helps if the room comes with them. Raise
    /// this without also raising the card's height and the strip loses exactly
    /// what the gap gained — the squeeze moves from above the figures to below.
    static let titleToFramesSpacing: CGFloat = 14
    static let controlsSlotHeight: CGFloat = 36
    static let bottomInset: CGFloat = 14

    /// Row 1 of the top band: the bird standing on the week's branch.
    ///
    /// ⚠️ Nothing may ever be placed above this row. The bird's clearance is the
    /// notch reserve directly above — black all the way to the top of the screen,
    /// and the only free open space on this card. Every other spot has to buy
    /// its clearance by growing the card or shrinking the figures.
    static let topRowHeight: CGFloat = 26
    static let topRowSpacing: CGFloat = 12

    /// The top band's right-hand column, shared by BOTH rows.
    ///
    /// ⚠️ These live on the band and not on either row: they are what makes the
    /// two rows read as a grid rather than as two unrelated strips, and a row
    /// reaching across to another row for them owns nothing.
    ///
    /// ⚠️ Fixed, never self-sizing. A column that resized with its text would
    /// change the branch's width on every rotation, moving all seven day
    /// boundaries and the bird with them. Wide enough that a caption carrying
    /// both project and agent does not truncate.
    static let rightColumnWidth: CGFloat = 152
    static let columnGutter: CGFloat = 16
}

struct GuidedCareCard: View {
    @ObservedObject var viewModel: IslandViewModel
    let topSafeInset: CGFloat

    private var move: CareMove { viewModel.currentMove }
    private var isActiveSession: Bool { viewModel.sessionPhase != .idle }

    var body: some View {
        VStack(spacing: 0) {
            Color.clear
                .frame(height: topSafeInset)

            // The top band: two rows, two columns. Left holds the two things
            // that can stretch (the branch, the wave), right holds a short line
            // for each. Every row is a complete sentence — an instrument on the
            // left, what it is saying on the right.
            VStack(spacing: GuidedCareLayout.topRowSpacing) {
                TopWeekRow(viewModel: viewModel)
                    .frame(height: GuidedCareLayout.topRowHeight)

                AgentActivityStrip(projects: viewModel.projects, flow: viewModel.flow,
                                   onTap: { viewModel.correctFlow() })
                    .frame(height: GuidedCareLayout.activityHeight, alignment: .leading)
            }
            .padding(.top, GuidedCareLayout.activityTopPadding)
            .padding(.horizontal, GuidedCareLayout.contentHorizontalInset)

            Spacer()
                .frame(height: GuidedCareLayout.activityToMainSpacing)

            // The main area eats the remaining height: no dead zone at the card's bottom
            mainContent
                .frame(maxHeight: .infinity)
                .padding(.horizontal, GuidedCareLayout.contentHorizontalInset)
                .padding(.bottom, GuidedCareLayout.bottomInset)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // Title row (title left, controls right) / the frame strip centered full-width, taking the whole bottom
    private var mainContent: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: GuidedCareLayout.titleToFramesSpacing) {
                HStack(alignment: .center, spacing: 12) {
                    title
                    Spacer(minLength: 12)
                    topControls
                }

                CareFrameStrip(
                    move: move,
                    currentFrameIndex: viewModel.currentFrameIndex,
                    isActiveSession: isActiveSession,
                    areaWidth: geometry.size.width
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    // Right end of the title row: idle = Start + divider + category dock grouped; active = pause; paused = continue/end
    @ViewBuilder
    private var topControls: some View {
        switch viewModel.sessionPhase {
        case .idle:
            HStack(spacing: 11) {
                CategoryDock(selected: move.category,
                             moveIndex: CareMovePool.index(of: move.id, in: move.category),
                             moveCount: CareMovePool.moves(in: move.category).count,
                             onSelect: viewModel.selectCategory)
                Rectangle()
                    .fill(IslandPalette.paper.opacity(0.16))
                    .frame(width: 1, height: 22)
                recommendationControls
            }
        case .active:
            HStack(spacing: 10) {
                repCount
                pauseButton
            }
        case .paused:
            HStack(spacing: 10) {
                repCount
                pausedControls
            }
        }
    }

    // Session counter: which rep you are on (core of the active state — keep)
    private var repCount: some View {
        Text("\(viewModel.completedReps)/\(move.reps)")
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(IslandPalette.paper)
            .monospacedDigit()
    }

    private var title: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text(move.name)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(IslandPalette.paper)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
                .layoutPriority(1)

            Image(systemName: "sparkle")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(IslandPalette.cue)
        }
    }

    // The one CTA, solid — an outlined style would fight the coral-outlined
    // category ring on the same row. Solid uses the DEEP coral accent, not the
    // bright coral cue: white text on cue is 1.9:1, mush; on accent it is
    // 4.6:1. The two corals split duties: cue does hints and outlines (spark,
    // category ring, fade bar), accent does this one solid CTA and nothing else.
    private var recommendationControls: some View {
        Button { viewModel.startSession() } label: {
            HStack(spacing: 6) {
                Text("Start")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(IslandPalette.paper)
                Text("\(move.seconds)s")   // duration is a footnote, one step quieter, doesn't compete with the verb
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(IslandPalette.paper.opacity(0.68))
            }
            .padding(.horizontal, 16)
            .frame(height: 32)
            .background(IslandPalette.accent, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private var pauseButton: some View {
        Button { viewModel.pauseSession() } label: {
            Image(systemName: "pause.fill")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(IslandPalette.paper)
                .frame(width: 38, height: 38)
                .overlay(Circle().stroke(IslandPalette.cue, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
    }

    private var pausedControls: some View {
        HStack(spacing: 10) {
            Button("Continue") { viewModel.resumeSession() }
                .buttonStyle(.plain)
                .foregroundStyle(IslandPalette.capsule)
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(IslandPalette.cue, in: Capsule())
            Button("End") { viewModel.endSession() }
                .buttonStyle(.plain)
                .foregroundStyle(IslandPalette.paper.opacity(0.58))
        }
    }
}

private struct CareFrameStrip: View {
    let move: CareMove
    let currentFrameIndex: Int
    let isActiveSession: Bool
    let areaWidth: CGFloat

    var body: some View {
        let frameSpacing: CGFloat = 10
        let layoutSlotCount = max(3, move.frames.count)
        let spacingWidth = frameSpacing * CGFloat(layoutSlotCount - 1)
        // Slots fill the full width: figures smaller than their slots → natural whitespace between images, no crowding
        let slotWidth = (areaWidth - spacingWidth) / CGFloat(layoutSlotCount)

        HStack(alignment: .center, spacing: frameSpacing) {
            ForEach(move.frames) { frame in
                let index = move.frames.firstIndex(of: frame)!
                CareFrameView(
                    frame: frame,
                    isActiveSession: isActiveSession,
                    isHighlighted: currentFrameIndex == index,
                    slotWidth: slotWidth,
                    beatDuration: move.frameDuration(at: index)
                )
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.spring(response: 0.34, dampingFraction: 0.76), value: currentFrameIndex)
    }
}

private struct CareFrameView: View {
    let frame: CareFrame
    let isActiveSession: Bool
    let isHighlighted: Bool
    let slotWidth: CGFloat
    let beatDuration: TimeInterval

    /// Progress through this beat (0→1). The bar under the current frame
    /// fades along it: solid at the start of a beat, gone exactly when it
    /// ends — and the frame changes at that instant. A static highlight can
    /// only say "this one is current", never "how long until the next" (which
    /// you need in order to anticipate). Move the bar, not the figure.
    @State private var breath: CGFloat = 0

    /// Highlight scale factor. scaleEffect enlarges the rendering without
    /// changing layout size, so the spacing below must budget for the overflow.
    private static let highlightScale: CGFloat = 1.14

    private var visualScale: CGFloat {
        guard isActiveSession else { return 1 }
        return isHighlighted ? Self.highlightScale : 0.92
    }

    private var visualOpacity: Double {
        guard isActiveSession else { return 1 }
        return isHighlighted ? 1 : 0.45
    }

    var body: some View {
        // Image smaller than its slot → whitespace on all sides, images stay
        // apart, the card can breathe. Why 0.9: the 4-frame move (eyes) has
        // the narrowest slots and anything smaller becomes illegible;
        // 2–3-frame moves sit at the 108 cap, unaffected; anything larger
        // pushes into the neighbors' whitespace and crowds the row.
        let imageSide = min(108, slotWidth * 0.9)
        // scaleEffect enlarges the rendering without changing layout size: the
        // highlighted frame overflows about 7% of the image height downward,
        // onto the bar below. The spacing reserves exactly the overflow, not a
        // hard-coded number.
        let scaleOverflow = imageSide * (Self.highlightScale - 1) / 2

        VStack(spacing: 4 + scaleOverflow) {
            Image(frame.assetName)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: imageSide, height: imageSide)
                .opacity(visualOpacity)
                .scaleEffect(visualScale)
                .zIndex(isHighlighted ? 1 : 0)

            // Coral underline for the current frame during a session; other
            // frames keep an equal-height placeholder so baselines match and
            // switching doesn't jump. The bar fades linearly with the beat:
            // the fainter the bar, the sooner the change — gone exactly at the switch.
            Rectangle()
                .fill(IslandPalette.cue)
                .frame(width: imageSide * 0.46, height: 2)
                .opacity(isActiveSession && isHighlighted ? Double(1 - breath) : 0)
        }
        .frame(width: slotWidth)
        // Session start/stop resets breath in its own update, so the next rise starts clean
        .onChange(of: isActiveSession, initial: true) { _, active in
            if active { restartBreath() } else { breath = 0 }
        }
        .onChange(of: isHighlighted) { _, _ in restartBreath() }
    }

    private func restartBreath() {
        guard isActiveSession, isHighlighted else {
            breath = 0
            return
        }
        breath = 0
        // Linear: only a constant fade speed lets you judge time remaining; easing misleads about the switch moment
        withAnimation(.linear(duration: beatDuration)) { breath = 1 }
    }

}

/// The category dock. The selected circle wears a ring that says "this area
/// holds several moves and you are on this one" — without the ring, "tap the
/// selected category = flip to the next move" leaves no visual trace and
/// nobody discovers the paging.
///
/// The ring is deliberately a CONTINUOUS base ring plus one bright arc, not a
/// circle cut into N segments: segments look broken, and "how many" is fully
/// carried by the arc's LENGTH (a quarter circle = four moves) — no counting gaps.
private struct CategoryDock: View {
    let selected: CareCategory
    let moveIndex: Int          // position of the current move in its category
    let moveCount: Int          // number of moves in the category
    let onSelect: (CareCategory) -> Void

    /// A monotonically increasing step count. Deriving the angle from
    /// moveIndex directly would sweep the arc BACKWARD most of a full turn
    /// when flipping from the last move to the first; accumulating a monotonic
    /// value keeps the animation "one step forward" forever, matching what the
    /// tap means.
    @State private var turn = 0

    private var ringVisible: Bool { moveCount > 1 }

    var body: some View {
        HStack(spacing: 7) {
            ForEach(CareMovePool.selectableCategories, id: \.rawValue) { category in
                Button { onSelect(category) } label: {
                    ZStack {
                        Circle()
                            .fill(IslandPalette.paper.opacity(category == selected ? 0.14 : 0.06))

                        if category == selected, ringVisible {
                            Circle()   // continuous base ring: a full circle, not one gap
                                .strokeBorder(IslandPalette.cue.opacity(0.18), lineWidth: 1.5)
                            Circle()   // bright arc: length = 1/moveCount, position = which move
                                .inset(by: 0.75)
                                .trim(from: 0, to: 1 / CGFloat(moveCount))
                                .stroke(IslandPalette.cue,
                                        style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                                .rotationEffect(.degrees(-90 + 360 * Double(turn) / Double(moveCount)))
                                .animation(.easeInOut(duration: 0.28), value: turn)
                        }

                        Image(systemName: CareMovePool.symbol(for: category))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(category == selected ? IslandPalette.cue : IslandPalette.paper.opacity(0.46))
                    }
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
            }
        }
        .onChange(of: moveIndex, initial: true) { _, newIndex in
            // Advance forward to newIndex's step (adding the difference), keeping turn % moveCount == moveIndex
            let n = max(moveCount, 1)
            let current = ((turn % n) + n) % n
            turn += ((newIndex - current) % n + n) % n
        }
    }
}
