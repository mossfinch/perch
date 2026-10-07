import SwiftUI

/// Orders projects by source: Claude, then codex, then any other agent. The
/// dots and the rotating label both read this order, so they agree.
private enum AgentRows {
    static let order = ["claude", "codex"]

    /// Only sources that have dots. An unknown source, from an agent wired up
    /// later, is still laid out, never dropped.
    static func rows(_ projects: [ProjectStatus]) -> [(source: String, items: [ProjectStatus])] {
        var sources = order.filter { src in projects.contains { $0.source == src } }
        for p in projects where !sources.contains(p.source) { sources.append(p.source) }
        return sources.map { src in (source: src, items: projects.filter { $0.source == src }) }
    }
}

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

// The project dots in the opened card, breathing and coloured by status.
private struct AgentStatusDots: View {
    let projects: [ProjectStatus]

    /// Only what is happening now: blue (running) and yellow (waiting on you).
    ///
    /// Green stays out. The top band splits by time: row 1 is the week and what
    /// just finished, row 2 is what is going on right now. Green means
    /// finished, so it already has a home one row up, where the finished
    /// project's name is shown. A green dot beside the wave would put one
    /// status in two places and blur what row 2 is for.
    ///
    /// Filtered here, not at the call site, on purpose: a second copy of this
    /// rule is how the two rows would drift back into showing the same thing.
    private var live: [ProjectStatus] {
        projects.filter { $0.status == .working || $0.status == .waiting }
    }

    var body: some View {
        let rows = AgentRows.rows(live)
        HStack(spacing: 5) {
            if rows.isEmpty {
                Circle().fill(IslandPalette.idleDot).frame(width: 6, height: 6)
            } else {
                // No text labels: 8pt captions would be the weakest, most
                // fragmented thing on this card. No .help() tooltips either:
                // the island is a non-activating panel where system tooltips
                // never appear, and a dead tooltip only tricks the next person
                // into thinking hover works.
                // One row for every agent. The name right beside the dots
                // (ActiveProjectLabel) already reads "<project> · <source>";
                // do not add a second place that says which agent.
                ForEach(rows, id: \.source) { row in
                    ForEach(row.items) { project in
                        ProjectDot(status: project.status)
                    }
                }
            }
        }
    }
}

/// The caption right of the wave: which project and which agent is running
/// now. Rotates when several run at once.
/// It must be persistent text: the island is a non-activating panel where
/// tooltips never appear, and text needs no hover.
private struct ActiveProjectLabel: View {
    /// The whole list. This view picks its own subject; a caller that
    /// pre-filtered would be a second place the "yellow wins" rule could be
    /// written, and so a second place it could drift.
    let projects: [ProjectStatus]

    @State private var slot = 0
    // The ticker must be @State: the parent (the whole card) redraws every
    // second with the viewModel, and a plain `let` publisher would be replaced
    // on every redraw, resetting the 3-second clock before it ever completes.
    @State private var ticker = Timer.publish(every: 3, on: .main, in: .common).autoconnect()

    /// The ones still running, in the same order as the dots beside them.
    private var running: [ProjectStatus] {
        AgentRows.rows(projects).flatMap(\.items).filter { $0.status == .working }
    }

    /// The ones waiting on you.
    private var waiting: [ProjectStatus] {
        AgentRows.rows(projects).flatMap(\.items).filter { $0.status == .waiting }
    }

    /// Yellow takes the label and pins it.
    ///
    /// Yellow is the one state of the four that needs you to do something;
    /// everything else is "still running, you don't have to care". Cycled with
    /// the others every three seconds, a project waiting on you would scroll
    /// past like any other: three seconds of a name you might not be looking
    /// at, then gone.
    ///
    /// So while anyone is waiting, they are all this cell shows, with the
    /// rotation stopped. With nobody waiting, it cycles the running ones.
    private var shown: [ProjectStatus] { waiting.isEmpty ? running : waiting }

    var body: some View {
        // Modulo instead of writing the out-of-range slot back: projects
        // finish and leave at any moment; normalizing at read time is simplest
        // and avoids chasing state inside onChange.
        let current = shown.isEmpty ? nil : shown[slot % shown.count]
        ZStack(alignment: .trailing) {   // old and new lines overlap during the cross-fade instead of pushing each other
            Text(current.map(ProjectCaption.caption) ?? "")
                .font(ProjectCaption.font)
                // The colour carries the state, so the caption never has to spell it
                // out: it names the project and nothing else.
                .foregroundStyle(IslandPalette.color(for: current?.status ?? .idle))
                .lineLimit(1)
                .truncationMode(.tail)
                .id(current?.id ?? "")
                .transition(.opacity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onReceive(ticker) { _ in
            // Something is waiting on you: the label is pinned, not rotating.
            guard waiting.isEmpty, shown.count > 1 else { return }
            withAnimation(.easeInOut(duration: 0.28)) {
                slot = (slot + 1) % shown.count
            }
        }
    }
}

struct AgentActivityStrip: View {
    let projects: [ProjectStatus]

    /// The island's verdict on whether you are in flow, mid-crossing and all.
    /// Without it the wave is decoration, a seeded pattern with a per-state
    /// speed; this is what turns it into a reading. Colour and height stay with
    /// the agent state: flow may only speak through brightness and pace, or it
    /// would drown out what the colours mean.
    let flow: FlowSense.Transition

    /// You say the verdict is wrong. The wave itself is the button: the thing
    /// making the claim is the thing you argue with, and there is no room on
    /// the island for a second control that would have to explain which reading
    /// it belongs to.
    let onTap: () -> Void

    /// Derived from the project list, the same source as the dots beside it,
    /// and not from viewModel.agentStatus: with two sources, any change in
    /// either side's clearing order puts a green dot beside a white wave that
    /// is still moving.
    private var status: IslandAgentStatus {
        if projects.contains(where: { $0.status == .waiting }) { return .waiting }
        if projects.contains(where: { $0.status == .working }) { return .working }
        if projects.contains(where: { $0.status == .done }) { return .done }
        return .idle
    }

    private static let barWidth: CGFloat = 2.4
    private static let barSpacing: CGFloat = 3.6

    var body: some View {
        // Row 2 of the top band: the wave stretches from the left margin, and
        // the dots and one project name sit in the right column, the same
        // width row 1 uses, so the two rows line up as a grid.
        HStack(spacing: GuidedCareLayout.columnGutter) {
            GeometryReader { geometry in
                let unit = Self.barWidth + Self.barSpacing
                let count = max(12, Int(geometry.size.width / unit))

                // Each bar runs on its own frequency/phase/ceiling and rises
                // and falls independently; density stays constant, and more
                // width only adds bars. When everything is done (green) the
                // wave freezes: refresh pauses and a fixed instant is sampled,
                // so it always stops in the same shape, never on a random frame.
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: isResting)) { context in
                    // The flow factor rides inside the clock instead of
                    // multiplying alongside the tempo; `waveClock` explains why
                    // scaling the wall clock by a factor that keeps moving
                    // turns the row into static. While the wave is frozen the
                    // timeline stops calling back, so the settled verdict is
                    // read instead of a level stuck at the moment it froze.
                    let time = isResting ? 0 : flow.waveClock(at: context.date) * tempo
                    let flowAlpha = FlowSense.opacity(for: isResting ? flow.to : flow.level(at: context.date))

                    HStack(alignment: .center, spacing: Self.barSpacing) {
                        ForEach(0..<count, id: \.self) { index in
                            let level = level(at: index, time: time)
                            Capsule()
                                .fill(pulseColor.opacity((0.34 + level * 0.62) * flowAlpha))
                                .frame(width: Self.barWidth, height: 3 + level * 19)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                }
            }
            .frame(height: 22)
            // The hit area is the strip, not the bars. A bar is 2.4pt wide
            // with 3.6pt of nothing beside it, so without this most presses
            // land in a gap and the island silently ignores you.
            .contentShape(Rectangle())
            .onTapGesture { onTap() }
            // An instrument may carry words and a border; it may not make the
            // person reading it guess. Hover feedback would have to move the
            // wave's brightness, which is the reading itself, so the affordance
            // is a tooltip instead, and the wave goes on saying only what it
            // means.
            .help("Press if this is wrong")
            .accessibilityLabel("Flow wave")
            .accessibilityHint("Press if this is wrong")

            // The dots and the name are one cell. Apart they are two weak
            // signals: a dot has no name, so its colour cannot say which
            // project it is, and a name far along the row from the dots does
            // not get read. Side by side, a dot has a name.
            //
            // The width is shared with row 1 on purpose. Two columns that do
            // not line up are not a grid, and the grid is what keeps this band
            // from looking scattered.
            HStack(spacing: 6) {
                AgentStatusDots(projects: projects)
                    .fixedSize()
                ActiveProjectLabel(projects: projects)
            }
            .frame(width: GuidedCareLayout.rightColumnWidth, alignment: .leading)
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
        // Skewed ceiling distribution: most bars short and a few tall, the
        // sharp look of a few spikes rising out of a field of short lines
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
