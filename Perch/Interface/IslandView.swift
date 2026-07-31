import SwiftUI

private enum IslandPalette {
    static let capsule = Color(red: 0.12, green: 0.10, blue: 0.095)
    static let paper = Color(red: 0.998, green: 0.996, blue: 0.991)
    static let accent = Color(red: 0.620, green: 0.372, blue: 0.322)
    static let cue = Color(red: 0.93, green: 0.64, blue: 0.56)
    static let idleDot = Color.white.opacity(0.40)
    // Four status colors (traffic-light semantics): blue = working / yellow = waiting on you / green = done / gray = idle (idleDot·paper)
    static let statusWorking = Color(red: 0.28, green: 0.62, blue: 0.98)   // blue
    static let statusWaiting = Color(red: 1.00, green: 0.80, blue: 0.24)   // yellow
    static let statusDone = Color(red: 0.30, green: 0.78, blue: 0.46)      // green

    /// One place for state → color, so the dots and the capsule's counts can
    /// never drift apart. (The leaf is not a caller: its idle tint is the
    /// paper color, not the dimmer dot gray.)
    static func color(for status: IslandAgentStatus) -> Color {
        switch status {
        case .idle: return idleDot
        case .working: return statusWorking
        case .waiting: return statusWaiting
        case .done: return statusDone
        }
    }
}

struct IslandView: View {
    @ObservedObject var viewModel: IslandViewModel

    var body: some View {
        let display = viewModel.display
        let phase = viewModel.presentationPhase

        // When closed, the card is REMOVED from the view tree, not kept at
        // opacity 0. The card holds a 30fps TimelineView (the wave) and a row
        // of frame animations — transparency does not stop them, and the
        // island is closed 90% of the time, which would mean burning a 30fps
        // animation around the clock. Both branches carry
        // .transition(.opacity) and cross-fade inside the ZStack.
        ZStack(alignment: .top) {
            if phase == .opened {
                openedPlaceholder(display: display)
                    .transition(.opacity)
            } else {
                capsule(display: display)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, display.openedShadowHorizontalInset)
        .padding(.bottom, display.openedShadowBottomInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// The closed capsule reports COUNTS, not one dot per project: how many
    /// are running, how many wait on you, how many finished. Why it stops
    /// there — including why the source is not shown — is in `StatusTally`.
    /// Per-project detail lives in the opened card, which has the room.
    ///
    /// Bare colored numerals rather than dot-plus-digit: at most three items
    /// means each digit can be 11pt — nearly twice the old 6pt dot — while
    /// the color still carries the state. An idle gray dot holds the place
    /// when nothing is happening, so the wing never looks broken-empty.
    private func statusCounts(display: IslandDisplayMetrics) -> some View {
        let counts = StatusTally.counts(viewModel.projects.map(\.status))
        return HStack(spacing: 6) {
            if counts.isEmpty {
                Circle().fill(IslandPalette.idleDot).frame(width: 6, height: 6)
            } else {
                ForEach(counts, id: \.status) { entry in
                    Text("\(entry.count)")
                        .font(.system(size: 11, weight: .semibold))
                        .monospacedDigit()   // a count that changes must not shift its neighbours
                        .foregroundStyle(IslandPalette.color(for: entry.status))
                }
            }
        }
        // Notched: the wing width is fixed, or the gap would stop lining up
        // with the physical notch. Elsewhere the row sizes itself.
        .frame(width: display.isNotched ? CGFloat(44) : nil, height: display.closedHeight)
    }

    private func capsule(display: IslandDisplayMetrics) -> some View {
        HStack(spacing: 0) {
            ClosedIslandMark(status: viewModel.agentStatus)
                .frame(width: display.isNotched ? 44 : 24, height: display.closedHeight)

            if display.isNotched {
                Color.clear.frame(width: display.notchGapWidth)
            } else {
                Spacer(minLength: 8)
            }

            statusCounts(display: display)
        }
        .padding(.horizontal, display.isNotched ? 0 : display.closedHeight / 2)
        .frame(width: display.closedWidth, height: display.closedHeight)
        .background(IslandPalette.capsule, in: IslandCapsuleShape(cornerRadius: display.closedHeight / 2))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 3)
    }

    private func openedPlaceholder(display: IslandDisplayMetrics) -> some View {
        let surfaceShape = IslandCardShape(
            topEdge: display.isNotched ? .notch : .topBar
        )

        // The card fills the panel with nothing stacked above it: the frame
        // height is fixed, so anything above the card would shrink the whole
        // card the moment it appears — and would sit behind the notch where
        // nobody can see it anyway.
        return GuidedCareCard(viewModel: viewModel, topSafeInset: display.closedHeight)
            .frame(width: display.layoutWidth, height: display.closedHeight + display.resultHeight)
            .background(IslandPalette.capsule, in: surfaceShape)
            .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
    }

}

/// Dot rows split by source: Claude on top, codex below.
/// In a single row, a few projects in and you can't tell whose dot is whose.
private enum AgentRows {
    static let order = ["claude", "codex"]

    /// Returns only rows that have dots. If another agent gets wired up, an
    /// unknown source must still be laid out — never silently dropped.
    static func rows(_ projects: [ProjectStatus]) -> [(source: String, items: [ProjectStatus])] {
        var sources = order.filter { src in projects.contains { $0.source == src } }
        for p in projects where !sources.contains(p.source) { sources.append(p.source) }
        return sources.map { src in (source: src, items: projects.filter { $0.source == src }) }
    }
}

// Shared by closed and open states: the project dot rows — breathing, colored
// by status. The top of the open card keeps agent visibility through it.
private struct AgentStatusDots: View {
    let projects: [ProjectStatus]

    var body: some View {
        let rows = AgentRows.rows(projects)
        VStack(alignment: .leading, spacing: 4) {
            if rows.isEmpty {
                Circle().fill(IslandPalette.idleDot).frame(width: 6, height: 6)
            } else {
                // No text labels: 8pt captions would be the weakest, most
                // fragmented thing on this card, and the two rows have a fixed
                // order (Claude top / codex bottom) you learn once. Don't add
                // .help() tooltips either — the island is a non-activating
                // panel where system tooltips never appear; a dead tooltip
                // only tricks the next person into thinking hover works.
                // For names, see ActiveProjectLabel.
                ForEach(rows, id: \.source) { row in
                    HStack(spacing: 5) {
                        ForEach(row.items) { project in
                            ProjectDot(status: project.status)
                        }
                    }
                }
            }
        }
    }
}

/// The persistent caption right of the wave: which project and which agent is
/// running now. Rotates when several run at once.
/// It must be persistent text: the island is a non-activating panel
/// (nonactivatingPanel) where tooltips never appear — persistent text needs
/// no hover and no memorizing "top row Claude, bottom row codex".
private struct ActiveProjectLabel: View {
    let active: [ProjectStatus]

    @State private var slot = 0
    // The ticker must be @State: the parent (the whole card) redraws every
    // second with the viewModel, and a plain `let` publisher would be replaced
    // on every redraw — the 3-second clock would reset before ever completing.
    @State private var ticker = Timer.publish(every: 3, on: .main, in: .common).autoconnect()

    /// Fixed width: text length varies with project names, and a self-sizing
    /// label would vary the wave's available width — the wave derives its bar
    /// count from width, so every rotation would reshuffle the whole row.
    /// Better to truncate long names.
    private static let width: CGFloat = 108

    var body: some View {
        // Modulo instead of writing the out-of-range slot back: projects
        // finish and leave at any moment; normalizing at read time is simplest
        // and avoids chasing state inside onChange.
        let current = active.isEmpty ? nil : active[slot % active.count]
        ZStack(alignment: .trailing) {   // old and new lines overlap during the cross-fade instead of pushing each other
            Text(current.map { "\($0.name) · \($0.source)" } ?? "")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(IslandPalette.paper.opacity(0.55))
                .lineLimit(1)
                .truncationMode(.tail)
                .id(current?.id ?? "")
                .transition(.opacity)
        }
        .frame(width: Self.width, alignment: .trailing)
        .onReceive(ticker) { _ in
            guard active.count > 1 else { return }   // don't blink when there is only one
            withAnimation(.easeInOut(duration: 0.28)) {
                slot = (slot + 1) % active.count
            }
        }
    }
}

private struct AgentActivityStrip: View {
    let projects: [ProjectStatus]

    /// Reads the same source as the dots right next to it: derived from the
    /// project list directly, NOT from viewModel.agentStatus — with two
    /// different sources, any change in either side's clearing order produces
    /// the contradiction "green dot + white still-moving wave".
    private var status: IslandAgentStatus {
        if projects.contains(where: { $0.status == .waiting }) { return .waiting }
        if projects.contains(where: { $0.status == .working }) { return .working }
        if projects.contains(where: { $0.status == .done }) { return .done }
        return .idle
    }

    /// Running = blue (working) or yellow (waiting). Green is already over —
    /// it shouldn't keep being announced, and it removes itself after 15
    /// minutes anyway. Same order as the dot rows (Claude first, codex after),
    /// no second ordering.
    private var activeProjects: [ProjectStatus] {
        AgentRows.rows(projects).flatMap { $0.items }
            .filter { $0.status == .working || $0.status == .waiting }
    }

    private static let barWidth: CGFloat = 2.4
    private static let barSpacing: CGFloat = 3.6

    var body: some View {
        // Dots hug the wave, the wave runs to the right edge: the row fills the full width, no dead gaps
        HStack(spacing: 12) {
            AgentStatusDots(projects: projects)
                .fixedSize()

            GeometryReader { geometry in
                let unit = Self.barWidth + Self.barSpacing
                let count = max(12, Int(geometry.size.width / unit))

                // Each bar runs on its own frequency/phase/ceiling and rises
                // and falls independently; density stays constant — width only
                // adds bars. When everything is done (green) the wave freezes:
                // refresh pauses and a fixed instant is sampled, so it always
                // stops in the same shape, never on a random frame.
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: isResting)) { context in
                    let time = isResting ? 0 : context.date.timeIntervalSinceReferenceDate * tempo

                    HStack(alignment: .center, spacing: Self.barSpacing) {
                        ForEach(0..<count, id: \.self) { index in
                            let level = level(at: index, time: time)
                            Capsule()
                                .fill(pulseColor.opacity(0.34 + level * 0.62))
                                .frame(width: Self.barWidth, height: 3 + level * 19)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                }
            }
            .frame(height: 22)

            // With nothing running the label disappears entirely and returns
            // its width to the wave — idle has nothing to announce.
            if !activeProjects.isEmpty {
                ActiveProjectLabel(active: activeProjects)
            }
        }
    }

    /// A deterministic but random-looking seed per bar (stable across frames, no jitter)
    private func seed(_ n: Int) -> Double {
        let x = sin(Double(n) * 12.9898) * 43758.5453
        return x - floor(x)   // 0…1
    }

    /// This bar's amplitude right now, 0…1. Each bar has its own
    /// frequency/phase/ceiling, so bars bounce one by one instead of forming
    /// a single smooth wave; a global breath multiplies on top so the row
    /// still moves with a shared pulse.
    private func level(at index: Int, time: Double) -> Double {
        let phase = seed(index) * 6.2831853
        let frequency = 1.6 + seed(index + 101) * 2.8     // each bar's own pace
        // Skewed ceiling distribution: most bars short, a few tall — the sharp
        // look of a few spikes rising out of a field of short lines
        let ceiling = 0.14 + pow(seed(index + 211), 2.2) * 0.86
        let swing = 0.5 + 0.5 * sin(time * frequency + phase)
        let breath = 0.78 + 0.22 * sin(time * 1.05)       // global breath
        return swing * ceiling * breath * amplitude
    }

    /// All done = the wave stops (frozen green); every other state keeps moving
    private var isResting: Bool { status == .done }

    private var tempo: Double {
        switch status {
        case .working: return 1.5
        case .waiting: return 1.1
        case .done:    return 0.8
        case .idle:    return 0.45   // idle: slow and shallow, but still moving = the island is alive
        }
    }

    private var amplitude: Double {
        status == .idle ? 0.42 : 1.0
    }

    private var pulseColor: Color {
        switch status {
        case .working: return IslandPalette.statusWorking
        case .waiting: return IslandPalette.statusWaiting
        case .done: return IslandPalette.statusDone
        case .idle: return IslandPalette.paper
        }
    }
}

private enum GuidedCareLayout {
    static let contentHorizontalInset: CGFloat = 40   // top rows keep extra distance from the side borders
    // Two dot rows need 4pt more than one. Those 4pt come out of the top
    // padding, not the main area — 18+22 and 14+26 both equal 40, so the
    // figure strip's height is untouched.
    static let activityTopPadding: CGFloat = 14        // wave's distance from the top border
    static let activityHeight: CGFloat = 26            // two dot rows (two 8pt label rows + 3pt gap)
    static let activityToMainSpacing: CGFloat = 12
    static let titleToFramesSpacing: CGFloat = 6
    static let controlsSlotHeight: CGFloat = 36
    static let bottomInset: CGFloat = 14
}

private struct GuidedCareCard: View {
    @ObservedObject var viewModel: IslandViewModel
    let topSafeInset: CGFloat

    private var move: CareMove { viewModel.currentMove }
    private var isActiveSession: Bool { viewModel.sessionPhase != .idle }

    var body: some View {
        VStack(spacing: 0) {
            Color.clear
                .frame(height: topSafeInset)

            // The top row holds only the wave (Start lives down on the title row)
            AgentActivityStrip(projects: viewModel.projects)
                .frame(height: GuidedCareLayout.activityHeight, alignment: .leading)
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

private struct ClosedIslandMark: View {
    let status: IslandAgentStatus

    private var color: Color {
        switch status {
        case .idle:    return IslandPalette.paper.opacity(0.74)
        case .working: return IslandPalette.statusWorking
        case .waiting: return IslandPalette.statusWaiting
        case .done:    return IslandPalette.statusDone
        }
    }

    @State private var scale: CGFloat = 1.0

    var body: some View {
        Image(systemName: "leaf.fill")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(color)                            // color purely status-driven, switches instantly (outside animation transactions)
            .scaleEffect(scale)
            .onChange(of: status, initial: true) { _, newStatus in
                if newStatus == .working || newStatus == .waiting {
                    scale = 1.0
                    withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) {
                        scale = 1.45                           // working/waiting: continuous scale pulse
                    }
                } else {
                    withAnimation(.easeInOut(duration: 0.22)) {
                        scale = 1.0                            // done/idle: settle clean and still (overrides the repeatForever above)
                    }
                }
            }
            .accessibilityLabel("Perch island status")
    }
}

// One project's status dot: pulses for working/waiting, still for done/idle
private struct ProjectDot: View {
    let status: IslandAgentStatus

    @State private var scale: CGFloat = 1.0

    var body: some View {
        Circle()
            .fill(IslandPalette.color(for: status))
            .frame(width: 6, height: 6)
            .scaleEffect(scale)
            .onChange(of: status, initial: true) { _, newStatus in
                if newStatus == .working || newStatus == .waiting {
                    scale = 1.0
                    withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) {
                        scale = 1.4
                    }
                } else {
                    withAnimation(.easeInOut(duration: 0.22)) {
                        scale = 1.0
                    }
                }
            }
    }
}
