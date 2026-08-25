import AppKit

/// Turns mouse movement and clicks in screen coordinates into the island's enter and exit
/// callbacks.
///
/// Callers supply the closed and expanded zones and report the current presentation state
/// through `isExpanded`. This type watches the pointer and absorbs jitter at the edges, but
/// it does not itself change the window, the view model, or `IslandPresentationPhase`.
/// All public state and callbacks are accessed on the main actor.
@MainActor
public final class IslandHoverMonitor {
    /// Reports whether the island is currently expanded. Treated as not expanded when unset.
    public var isExpanded: (() -> Bool)?
    /// Called when the pointer's entry into the closed zone is confirmed, or the closed zone
    /// is clicked.
    public var onHoverEntered: (() -> Void)?
    /// Called when the pointer leaves the expanded zone while expanded, or a click lands
    /// outside it.
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
    /// A hover must last 150 ms before opening, so a pointer merely crossing the top of the
    /// screen does not trigger it.
    private let hoverOpenDelay: UInt64 = 150_000_000
    /// When the pointer briefly slips past the edge of the closed zone, wait 100 ms before
    /// cancelling a pending open.
    /// This is not a close delay for the expanded state; it only protects a hover-open that
    /// is still waiting.
    private let hoverCancelGrace: UInt64 = 100_000_000

    private var closedZone: NSRect = .zero
    private var expandedZone: NSRect = .zero

    public init() {}

    /// Whether the expanded zone should still count as occupied by the pointer.
    /// Always false while the island is not expanded. Once expanded it checks the latest
    /// location but also keeps a confirmed entry standing, until a later move or an outside
    /// click explicitly triggers an exit.
    public var isPointerInsideExpandedSurface: Bool {
        guard isExpanded?() == true else { return false }
        return pointerHasEnteredExpandedSurface
            || rectContainsIncludingEdges(expandedZone, point: latestMouseLocation)
    }

    /// Installs the in-process and out-of-process mouse monitors plus the position poll.
    /// Calling it again while installed does nothing.
    ///
    /// AppKit's local monitor covers this app's events and the global monitor covers events
    /// in other apps; without both, some pointer activity is missed. The 80 ms poll does not
    /// depend on event delivery, so the current position is resampled even when no monitor
    /// fires. Callers should set the zones and callbacks first, and call `stop()` before
    /// discarding this object.
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

    /// Replaces the hit zones. Both rects and `NSEvent.mouseLocation` must use the same
    /// screen coordinate space.
    /// Callers must supply new zones after a change of screen, resolution, or window
    /// geometry.
    public func updateZones(closed: NSRect, expanded: NSRect) {
        closedZone = closed
        expandedZone = expanded
    }

    /// Removes every event monitor and the poll, and cancels any pending hover task.
    /// Safe to call repeatedly; it does not clear the callbacks, the zones, or the latest
    /// location, so `start()` can be called again afterwards.
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

    /// Handles one sample of the pointer's screen position.
    /// While closed, a position inside the hit zone schedules the delayed open; while
    /// expanded, it only tracks whether the pointer has left the expanded zone.
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

    /// Handles one left click.
    /// A click in the closed zone skips the hover delay and enters immediately; while
    /// expanded, a click outside the zone exits immediately.
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

    /// While expanded, sends the exit callback exactly once, on the transition from
    /// "already entered" to "moved out of the zone".
    private func trackExpandedSurface(_ mouseLocation: NSPoint) {
        if rectContainsIncludingEdges(expandedZone, point: mouseLocation) {
            pointerHasEnteredExpandedSurface = true
            return
        }

        guard pointerHasEnteredExpandedSurface else { return }
        pointerHasEnteredExpandedSurface = false
        onHoverExited?()
    }

    /// Schedules the hover open; when the task wakes it rechecks the presentation state and
    /// the latest pointer position.
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

    /// Defers cancelling a pending open.
    /// If the pointer returns to the closed zone within the grace period,
    /// `scheduleHoverOpen` revokes the cancellation and keeps the original 150 ms running,
    /// so jitter at the edge does not restart the count over and over.
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

    /// Cancels the hover open and its cancellation grace immediately.
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
