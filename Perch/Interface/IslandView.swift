import SwiftUI

struct IslandView: View {
    @ObservedObject var viewModel: IslandViewModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The row the tab adds under the closed capsule while the island is asking for a
    /// break. The hover zone grows by the same amount, or the tab would look like part of
    /// the island while clicks on it went to the app underneath.
    static let stretchTabHeight: CGFloat = 24

    /// How far apart the letters of the tab's line ease at the top of a breath, in points. The
    /// tests check the stretched line still fits the narrowest tab.
    static let stretchSpread: CGFloat = 1.9

    var body: some View {
        let display = viewModel.display
        let phase = viewModel.presentationPhase

        // When closed, the card leaves the view tree instead of sitting at
        // opacity 0. It holds a 30fps TimelineView (the wave) and a row of frame
        // animations, which transparency does not stop, and the island is
        // closed most of the time: a hidden card would burn a 30fps animation
        // around the clock. Both branches carry .transition(.opacity) and
        // cross-fade inside the ZStack.
        ZStack(alignment: .top) {
            if phase == .opened {
                openedPlaceholder(display: display)
                    .transition(.opacity)
            } else {
                capsule(display: display)
                    .background(alignment: .top) {
                        if viewModel.stretchNudge { stretchTab(display: display) }
                    }
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, display.openedShadowHorizontalInset)
        .padding(.bottom, display.openedShadowBottomInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// The closed capsule shows counts, not one dot per project: how many are
    /// running, how many wait on you, how many finished (see `StatusTally`).
    /// Per-project detail lives in the opened card, which has the room.
    ///
    /// Bare coloured numerals, no dot beside them: with at most three items
    /// each digit can be 11pt, big enough to read at a glance where a 6pt dot
    /// can only be lit or unlit, and the colour still carries the state. An
    /// idle grey dot holds the place when nothing is happening, so the wing
    /// never looks broken and empty.
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
            // The bird alone, standing on nothing: deliberately no plinth.
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
        // Read here, on the main actor: the animator's closure may run elsewhere.
        let shake: CGFloat = reduceMotion ? 0 : 1

        // The card fills the panel with nothing stacked above it: the frame
        // height is fixed, so anything above the card would shrink the whole
        // card the moment it appears, and it would sit behind the notch where
        // nobody can see it anyway.
        return GuidedCareCard(viewModel: viewModel, topSafeInset: display.closedHeight)
            .frame(width: display.layoutWidth, height: display.closedHeight + display.resultHeight)
            .background(IslandPalette.capsule, in: surfaceShape)
            .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
            // When the card opens to ask for a break it shakes once, the way a refused
            // password does: the corner of an eye catches motion long before it reads a
            // line of text. Routine peeks never bump the trigger, so they stay still.
            .keyframeAnimator(initialValue: CGFloat.zero, trigger: viewModel.stretchShake) { card, x in
                card.offset(x: x * shake)
            } keyframes: { _ in
                KeyframeTrack {
                    LinearKeyframe(-9, duration: 0.06)
                    LinearKeyframe(9, duration: 0.08)
                    LinearKeyframe(-7, duration: 0.08)
                    LinearKeyframe(7, duration: 0.08)
                    LinearKeyframe(-3, duration: 0.07)
                    LinearKeyframe(0, duration: 0.07)
                }
            }
    }

    /// Hangs under the closed capsule while an ask is open, until a move is finished or no
    /// agent has run for `StretchNudge.away`. Drawn behind the capsule, so the bird's wing is
    /// untouched and the capsule's lower corners blend into the tab.
    private func stretchTab(display: IslandDisplayMetrics) -> some View {
        // Read here, on the main actor: the animator's closure may run elsewhere.
        let still = reduceMotion
        // Each bump of the trigger plays one slow breath: the letters ease apart, hold, and
        // settle back more slowly, so the line stretches the way it asks you to. Nothing runs
        // between breaths. Letter spacing only exists on Text, so the row is rebuilt from each
        // value.
        return KeyframeAnimator(initialValue: Breath(), trigger: viewModel.stretchPulse) { breath in
            HStack(spacing: 6) {
                Circle()
                    .fill(IslandPalette.cue)
                    .frame(width: 6, height: 6)
                    .scaleEffect(still ? 1 : breath.dot)
                Text(StretchNudge.line)
                    .font(ProjectCaption.font)
                    .tracking(still ? 0 : breath.spread)
                    .foregroundStyle(IslandPalette.cue)
                    .lineLimit(1)
            }
            .shadow(color: IslandPalette.cue.opacity(still ? 0 : breath.glow), radius: 4)
        } keyframes: { _ in
            KeyframeTrack(\.spread) {
                CubicKeyframe(Self.stretchSpread, duration: 1.3)
                LinearKeyframe(Self.stretchSpread, duration: 0.5)
                CubicKeyframe(0, duration: 1.8)
            }
            KeyframeTrack(\.dot) {
                CubicKeyframe(1.35, duration: 1.3)
                LinearKeyframe(1.35, duration: 0.5)
                CubicKeyframe(1, duration: 1.8)
            }
            KeyframeTrack(\.glow) {
                CubicKeyframe(0.55, duration: 1.3)
                LinearKeyframe(0.55, duration: 0.5)
                CubicKeyframe(0, duration: 1.8)
            }
        }
        .frame(height: Self.stretchTabHeight)
        .padding(.top, display.closedHeight)
        .frame(width: display.closedWidth, height: display.closedHeight + Self.stretchTabHeight,
               alignment: .top)
        .background(IslandPalette.capsule,
                    in: IslandCapsuleShape(cornerRadius: Self.stretchTabHeight / 2))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 3)
    }

}

/// The animated values of one breath of the tab: letter spacing, dot scale and glow.
private struct Breath {
    var spread: CGFloat = 0
    var dot: CGFloat = 1
    var glow = 0.0
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

    private var breathing: Bool { status == .working || status == .waiting }

    var body: some View {
        // The app's own bird, lifted from its icon. The `bird.fill` symbol is
        // mid-flight with its wings raised and reads as a different creature.
        //
        // 20pt is the floor. The bird stands upright (3:4), so below about 20pt
        // tall it is under 15pt wide and collapses into a sliver.
        //
        // Core Animation runs the breath on a layer in the render server.
        // This avoids driving SwiftUI view updates for every animation frame;
        // the view still updates the bird's colour and breathing state.
        Bird(color: NSColor(color), breathing: breathing)
            .frame(width: 15, height: 20)
            .accessibilityLabel("Perch island status")
    }

    private struct Bird: NSViewRepresentable {
        let color: NSColor
        let breathing: Bool

        func makeNSView(context: Context) -> BirdView { BirdView() }

        func updateNSView(_ view: BirdView, context: Context) {
            view.color = color
            view.breathing = breathing
        }
    }

    /// One solid-colour layer wearing the bird's alpha as its mask: the shape
    /// comes from the asset, the colour still means agent status.
    private final class BirdView: NSView {
        private let body = CALayer()
        private let shape = CALayer()
        private static let breath = "breath"

        var color: NSColor = .white {
            didSet {
                // Instant: a status change is a fact, not a fade, and layers
                // fade property changes by default.
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                body.backgroundColor = color.cgColor
                CATransaction.commit()
            }
        }

        var breathing = false {
            didSet {
                guard breathing != oldValue else { return }
                if breathing {
                    let swell = CABasicAnimation(keyPath: "transform.scale")
                    swell.fromValue = 1.0
                    // Gentle on purpose: at this size a swell of half again
                    // looks like inflating, and it would overrun the 38pt
                    // wing. A perched bird breathes, it does not grow.
                    swell.toValue = 1.08
                    swell.duration = 0.55
                    swell.autoreverses = true
                    swell.repeatCount = .infinity
                    swell.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    body.add(swell, forKey: Self.breath)
                } else {
                    // Removing the animation settles the layer at its model
                    // value, which never left 1.0: clean and still.
                    body.removeAnimation(forKey: Self.breath)
                }
            }
        }

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            shape.contents = NSImage(named: "PerchBird")
            shape.contentsGravity = .resizeAspect
            body.mask = shape
            layer?.addSublayer(body)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func layout() {
            super.layout()
            // Our own sublayer, so its anchor is the centre and the swell
            // grows around it; a view's backing layer is anchored at a corner.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            body.bounds = bounds
            body.position = CGPoint(x: bounds.midX, y: bounds.midY)
            shape.frame = body.bounds
            CATransaction.commit()
        }

        override func viewDidChangeBackingProperties() {
            super.viewDidChangeBackingProperties()
            let scale = window?.backingScaleFactor ?? 2
            body.contentsScale = scale
            shape.contentsScale = scale
        }
    }
}
