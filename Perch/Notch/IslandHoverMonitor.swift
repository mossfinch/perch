import AppKit

/// Turns pointer movement and clicks, in screen coordinates, into the island's enter and
/// exit callbacks, absorbing jitter at the edges. Callers supply the zones and the
/// presentation state; this type changes neither.
@MainActor
public final class IslandHoverMonitor {
    /// Unset counts as not expanded.
    public var isExpanded: (() -> Bool)?
    /// After a confirmed hover over the closed zone, or a click on it.
    public var onHoverEntered: (() -> Void)?
    /// When the pointer leaves the expanded zone, or a click lands outside it.
    public var onHoverExited: (() -> Void)?

    private var globalMoveMonitor: Any?
    private var localMoveMonitor: Any?
    private var globalClickMonitor: Any?
    private var localClickMonitor: Any?
    private var pointerPollTimer: Timer?
    private var hoverOpenTask: Task<Void, Never>?
    private var hoverCancelGraceTask: Task<Void, Never>?
    private var pointerHasEnteredExpandedSurface = false
    private var latestMouseLocation: NSPoint = .zero
    /// A pointer merely crossing the top of the screen must not open the island.
    private let hoverOpenDelay: UInt64 = 150_000_000
    /// How long the pointer may slip past the closed zone's edge before a pending open is
    /// cancelled. It only protects an open that is still waiting; it never delays closing.
    private let hoverCancelGrace: UInt64 = 100_000_000

    private var closedZone: NSRect = .zero
    private var expandedZone: NSRect = .zero

    public init() {}

    /// A confirmed entry keeps counting until a later move or an outside click exits, even
    /// when the latest location is outside the zone. Always false while not expanded.
    public var isPointerInsideExpandedSurface: Bool {
        guard isExpanded?() == true else { return false }
        return pointerHasEnteredExpandedSurface
            || rectContainsIncludingEdges(expandedZone, point: latestMouseLocation)
    }

    /// AppKit's local monitor sees this app's events and the global monitor sees other
    /// apps'; without both, some pointer activity is missed. The 80 ms poll does not depend
    /// on event delivery, so the position is resampled even when no monitor fires.
    /// Set the zones and callbacks first, and call `stop()` before discarding this object.
    public func start() {
        guard globalMoveMonitor == nil, localMoveMonitor == nil else { return }

        let throttleInterval: TimeInterval = 0.05
        // The two event callbacks share this throttle timestamp before hopping back to the
        // main actor. `nonisolated(unsafe)` only bypasses the isolation check and provides
        // no synchronization; if the callbacks' execution context ever changes, this must
        // become explicitly synchronized state.
        nonisolated(unsafe) var sharedLastMove: TimeInterval = 0

        globalMoveMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in
            let now = ProcessInfo.processInfo.systemUptime
            guard now - sharedLastMove >= throttleInterval else { return }
            sharedLastMove = now
            Task { @MainActor in
                self?.handleMouseMoved(NSEvent.mouseLocation)
            }
        }

        localMoveMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            let now = ProcessInfo.processInfo.systemUptime
            guard now - sharedLastMove >= throttleInterval else { return event }
            sharedLastMove = now
            Task { @MainActor in
                self?.handleMouseMoved(NSEvent.mouseLocation)
            }
            return event
        }

        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] _ in
            Task { @MainActor in
                self?.handleMouseDown(NSEvent.mouseLocation)
            }
        }

        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] event in
            Task { @MainActor in
                self?.handleMouseDown(NSEvent.mouseLocation)
            }
            return event
        }

        // A backstop sample independent of the event monitors; it does not go through the
        // 50 ms event throttle above.
        pointerPollTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.handleMouseMoved(NSEvent.mouseLocation)
            }
        }
    }

    /// Both rects must be in the same screen coordinate space as `NSEvent.mouseLocation`.
    /// Supply new zones after any change of screen, resolution or window geometry.
    public func updateZones(closed: NSRect, expanded: NSRect) {
        closedZone = closed
        expandedZone = expanded
    }

    /// Safe to call repeatedly. It keeps the callbacks and zones, so `start()` can be called
    /// again afterwards.
    public func stop() {
        if let globalMoveMonitor {
            NSEvent.removeMonitor(globalMoveMonitor)
        }
        if let localMoveMonitor {
            NSEvent.removeMonitor(localMoveMonitor)
        }
        if let globalClickMonitor {
            NSEvent.removeMonitor(globalClickMonitor)
        }
        if let localClickMonitor {
            NSEvent.removeMonitor(localClickMonitor)
        }
        pointerPollTimer?.invalidate()
        globalMoveMonitor = nil
        localMoveMonitor = nil
        globalClickMonitor = nil
        localClickMonitor = nil
        pointerPollTimer = nil
        cancelTimers()
        pointerHasEnteredExpandedSurface = false
    }

    func handleMouseMoved(_ mouseLocation: NSPoint) {
        latestMouseLocation = mouseLocation

        if isExpanded?() == true {
            cancelHoverOpenImmediately()
            trackExpandedSurface(mouseLocation)
            return
        }

        if rectContainsIncludingEdges(closedZone, point: mouseLocation) {
            scheduleHoverOpen()
        } else {
            cancelHoverOpen()
        }
    }

    /// A click skips the hover delay: on the closed zone it enters at once, and outside the
    /// expanded zone it exits at once.
    func handleMouseDown(_ mouseLocation: NSPoint) {
        latestMouseLocation = mouseLocation

        if isExpanded?() == true {
            if !rectContainsIncludingEdges(expandedZone, point: mouseLocation) {
                pointerHasEnteredExpandedSurface = false
                onHoverExited?()
            }
            return
        }

        guard rectContainsIncludingEdges(closedZone, point: mouseLocation) else { return }
        cancelHoverOpenImmediately()
        pointerHasEnteredExpandedSurface = true
        onHoverEntered?()
    }

    /// Sends the exit callback once, when an entered pointer moves out of the zone.
    private func trackExpandedSurface(_ mouseLocation: NSPoint) {
        if rectContainsIncludingEdges(expandedZone, point: mouseLocation) {
            pointerHasEnteredExpandedSurface = true
            return
        }

        guard pointerHasEnteredExpandedSurface else { return }
        pointerHasEnteredExpandedSurface = false
        onHoverExited?()
    }

    /// The task rechecks the presentation state and the latest position when it wakes.
    private func scheduleHoverOpen() {
        hoverCancelGraceTask?.cancel()
        hoverCancelGraceTask = nil

        guard hoverOpenTask == nil else { return }

        hoverOpenTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: hoverOpenDelay)
            guard !Task.isCancelled else { return }
            guard isExpanded?() != true else { return }
            guard rectContainsIncludingEdges(closedZone, point: latestMouseLocation) else { return }
            pointerHasEnteredExpandedSurface = true
            onHoverEntered?()
            hoverOpenTask = nil
        }
    }

    /// If the pointer returns within the grace period, `scheduleHoverOpen` revokes the
    /// cancellation and the original 150 ms keeps running, so jitter at the edge does not
    /// restart the count.
    private func cancelHoverOpen() {
        guard hoverOpenTask != nil else { return }
        guard hoverCancelGraceTask == nil else { return }

        hoverCancelGraceTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: hoverCancelGrace)
            hoverOpenTask?.cancel()
            hoverOpenTask = nil
            hoverCancelGraceTask = nil
        }
    }

    private func cancelHoverOpenImmediately() {
        hoverCancelGraceTask?.cancel()
        hoverCancelGraceTask = nil
        hoverOpenTask?.cancel()
        hoverOpenTask = nil
    }

    private func cancelTimers() {
        cancelHoverOpenImmediately()
    }

    /// Counts the rect's own boundary as a hit, so a pointer sitting exactly on the edge
    /// does not flip the state back and forth.
    private func rectContainsIncludingEdges(_ rect: NSRect, point: NSPoint) -> Bool {
        point.x >= rect.minX
            && point.x <= rect.maxX
            && point.y >= rect.minY
            && point.y <= rect.maxY
    }
}
