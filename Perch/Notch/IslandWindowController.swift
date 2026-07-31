import AppKit
import Combine
import SwiftUI

@MainActor
final class IslandWindowController: NSWindowController {
    private enum Metrics {
        static let topWingWidth: CGFloat = 44
        static let externalClosedWidth: CGFloat = 340
        static let externalNotchWidth: CGFloat = 190
        static let externalClosedHeight: CGFloat = 38
        static let externalOpenedWidth: CGFloat = 520
        static let notchedOpenedWidth: CGFloat = 540
        static let openedResultHeight: CGFloat = 260
        static let openedShadowHorizontalInset: CGFloat = 18
        static let openedShadowBottomInset: CGFloat = 22
    }

    private let viewModel = IslandViewModel()
    private let hoverMonitor = IslandHoverMonitor()
    private var cancellables: Set<AnyCancellable> = []
    /// No deinit removal: the app delegate owns this controller for the app's
    /// whole lifetime, so it is never deallocated. The notification block uses
    /// `[weak self]`, so there is no retain cycle either.
    private var screenObserver: NSObjectProtocol?

    init() {
        let fallback = IslandDisplayMetrics.fallback
        let window = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: fallback.windowWidth, height: fallback.windowHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.isFloatingPanel = true
        window.level = .statusBar
        window.sharingType = .readOnly
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.isMovable = false
        window.hidesOnDeactivate = false
        window.acceptsMouseMovedEvents = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        window.ignoresMouseEvents = true
        super.init(window: window)
        installContentView()
        configureHoverMonitor()
        observePresentationPhase()
        observeScreenChanges()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    /// Position the panel and bring it up. **Idempotent, safe to rerun any
    /// time** — screen changes are handled precisely by rerunning it.
    func activate() {
        guard let window, let screen = targetScreen() else { return }
        let display = displayMetrics(for: screen)
        let windowFrame = panelFrame(for: display, on: screen)
        if window.frame != windowFrame {
            window.setFrame(windowFrame, display: true)
        }
        viewModel.display = display
        updateHoverZones(for: display, on: screen)
        hoverMonitor.start()
        window.orderFrontRegardless()
    }

    private func installContentView() {
        guard let window else { return }
        let hostingView = IslandHostingView(rootView: IslandView(viewModel: viewModel))
        hostingView.hitTestRectProvider = { [weak self] in
            self?.interactiveContentRect()
        }
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = .clear
        window.contentView = hostingView
    }

    private func observePresentationPhase() {
        viewModel.$presentationPhase
            .sink { [weak self] phase in
                self?.setInteractive(phase == .opened)
            }
            .store(in: &cancellables)
    }

    /// Display plugged / unplugged / lid closed / resolution changed — all of
    /// them require recomputing coordinates.
    ///
    /// The panel's position, size, and hover zones are all computed in
    /// `activate()` against THE screen of that moment. After a screen change
    /// those coordinates point at a screen that no longer exists and the
    /// island vanishes — the process stays alive, events keep arriving, it
    /// just draws where nobody can see. Looks exactly like a crash.
    private func observeScreenChanges() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.activate() }
        }
    }

    private func setInteractive(_ interactive: Bool) {
        guard let window else { return }
        window.ignoresMouseEvents = !interactive
        window.acceptsMouseMovedEvents = interactive
        if interactive {
            window.orderFrontRegardless()
        }
    }

    private func interactiveContentRect() -> NSRect? {
        guard viewModel.presentationPhase == .opened,
              let window else {
            return nil
        }

        let display = viewModel.display
        let bounds = NSRect(origin: .zero, size: window.frame.size)
        return NSRect(
            x: bounds.minX + display.openedShadowHorizontalInset,
            y: bounds.minY + display.openedShadowBottomInset,
            width: max(0, bounds.width - (display.openedShadowHorizontalInset * 2)),
            height: max(0, bounds.height - display.openedShadowBottomInset)
        )
    }

    private func configureHoverMonitor() {
        hoverMonitor.isExpanded = { [weak self] in
            self?.viewModel.presentationPhase == .opened
        }
        hoverMonitor.onHoverEntered = { [weak self] in
            self?.viewModel.hoverEntered()
        }
        hoverMonitor.onHoverExited = { [weak self] in
            self?.viewModel.hoverExited()
        }
    }

    private func updateHoverZones(for display: IslandDisplayMetrics, on screen: NSScreen) {
        hoverMonitor.updateZones(
            closed: closedSurfaceRect(for: display, on: screen),
            expanded: expandedSurfaceRect(for: display, on: screen)
        )
    }

    private func closedSurfaceRect(for display: IslandDisplayMetrics, on screen: NSScreen) -> NSRect {
        let visualRect = NSRect(
            x: screen.frame.midX - display.closedWidth / 2,
            y: screen.frame.maxY - display.closedHeight,
            width: display.closedWidth,
            height: display.closedHeight
        )
        return visualRect.insetBy(dx: -80, dy: -6)
    }

    private func expandedSurfaceRect(for display: IslandDisplayMetrics, on screen: NSScreen) -> NSRect {
        let frame = panelFrame(for: display, on: screen)
        return NSRect(
            x: frame.minX + display.openedShadowHorizontalInset,
            y: frame.minY + display.openedShadowBottomInset,
            width: max(0, frame.width - (display.openedShadowHorizontalInset * 2)),
            height: max(0, frame.height - display.openedShadowBottomInset)
        )
    }

    private func panelFrame(for display: IslandDisplayMetrics, on screen: NSScreen) -> NSRect {
        NSRect(
            x: screen.frame.midX - display.windowWidth / 2,
            y: screen.frame.maxY - display.windowHeight,
            width: display.windowWidth,
            height: display.windowHeight
        )
    }

    private func targetScreen() -> NSScreen? {
        let screens = NSScreen.screens
        if let notchScreen = screens.first(where: { $0.safeAreaInsets.top > 0 }) {
            return notchScreen
        }
        return NSScreen.main ?? screens.first
    }

    private func displayMetrics(for screen: NSScreen) -> IslandDisplayMetrics {
        let isNotched = isNotchedScreen(screen)
        let notchWidth = screenNotchWidth(for: screen, isNotched: isNotched)
        let closedHeight = closedHeight(for: screen, isNotched: isNotched)
        let closedWidth = isNotched
            ? notchWidth + (Metrics.topWingWidth * 2)
            : Metrics.externalClosedWidth
        let preferredResultWidth = isNotched ? Metrics.notchedOpenedWidth : Metrics.externalOpenedWidth
        let resultWidth = min(preferredResultWidth, max(240, screen.visibleFrame.width - 32))
        let resultHeight = Metrics.openedResultHeight
        let layoutWidth = max(closedWidth, resultWidth)
        let layoutHeight = closedHeight + resultHeight
        let shadowH = Metrics.openedShadowHorizontalInset
        let shadowB = Metrics.openedShadowBottomInset
        let windowWidth = layoutWidth + (shadowH * 2)
        let windowHeight = layoutHeight + shadowB

        return IslandDisplayMetrics(
            isNotched: isNotched,
            windowWidth: windowWidth,
            windowHeight: windowHeight,
            closedWidth: closedWidth,
            closedHeight: closedHeight,
            notchGapWidth: isNotched ? notchWidth : 0,
            resultWidth: resultWidth,
            resultHeight: resultHeight,
            layoutWidth: layoutWidth,
            layoutHeight: layoutHeight,
            openedShadowHorizontalInset: shadowH,
            openedShadowBottomInset: shadowB
        )
    }

    private func isNotchedScreen(_ screen: NSScreen) -> Bool {
        screen.safeAreaInsets.top > 0
            || screen.auxiliaryTopLeftArea?.isEmpty == false
            || screen.auxiliaryTopRightArea?.isEmpty == false
    }

    private func screenNotchWidth(for screen: NSScreen, isNotched: Bool) -> CGFloat {
        guard isNotched else { return Metrics.externalNotchWidth }
        if let leftArea = screen.auxiliaryTopLeftArea,
           let rightArea = screen.auxiliaryTopRightArea {
            return max(120, screen.frame.width - leftArea.width - rightArea.width + 4)
        }
        return Metrics.externalNotchWidth
    }

    private func closedHeight(for screen: NSScreen, isNotched: Bool) -> CGFloat {
        if isNotched, screen.safeAreaInsets.top > 0 {
            return screen.safeAreaInsets.top
        }
        let reservedTopInset = max(0, screen.frame.maxY - screen.visibleFrame.maxY)
        if reservedTopInset > 0 {
            return reservedTopInset
        }
        return Metrics.externalClosedHeight
    }
}

private final class IslandHostingView<Content: View>: NSHostingView<Content> {
    var hitTestRectProvider: (() -> NSRect?)?

    override var isOpaque: Bool {
        false
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let contentRect = hitTestRectProvider?(),
              contentRect.contains(point) else {
            return nil
        }
        return super.hitTest(point) ?? self
    }
}
