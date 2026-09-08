import SwiftUI

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
    /// means each digit can be 11pt — big enough to read at a glance, where
    /// a 6pt dot can only be lit or unlit — while the color still carries
    /// the state. An idle gray dot holds the place
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

    /// Breathes while an agent runs or waits; still when done or idle.
    private var breathing: Bool { status == .working || status == .waiting }

    var body: some View {
        // The app's own bird, lifted from its icon. Not the `bird.fill`
        // symbol: that one is mid-flight with its wings raised and reads as a
        // different creature from the one on the icon.
        //
        // ⚠️ 20pt is a floor, not a preference. The bird stands upright (3:4),
        // so below about 20pt tall it is under 15pt wide and collapses into a
        // sliver.
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
                // Instant, as `.foregroundStyle` was: a status change is a
                // fact, not a fade, and layers fade property changes by default.
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
