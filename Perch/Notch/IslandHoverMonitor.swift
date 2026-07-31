import AppKit

@MainActor
public final class IslandHoverMonitor {
    public var isExpanded: (() -> Bool)?
    public var onHoverEntered: (() -> Void)?
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
    private let hoverOpenDelay: UInt64 = 150_000_000
    private let hoverCancelGrace: UInt64 = 100_000_000

    private var closedZone: NSRect = .zero
    private var expandedZone: NSRect = .zero

    public init() {}

    public var isPointerInsideExpandedSurface: Bool {
        guard isExpanded?() == true else { return false }
        return pointerHasEnteredExpandedSurface
            || rectContainsIncludingEdges(expandedZone, point: latestMouseLocation)
    }

    public func start() {
        guard globalMoveMonitor == nil, localMoveMonitor == nil else { return }

        let throttleInterval: TimeInterval = 0.05
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

        pointerPollTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.handleMouseMoved(NSEvent.mouseLocation)
            }
        }
    }

    public func updateZones(closed: NSRect, expanded: NSRect) {
        closedZone = closed
        expandedZone = expanded
    }

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

    private func trackExpandedSurface(_ mouseLocation: NSPoint) {
        if rectContainsIncludingEdges(expandedZone, point: mouseLocation) {
            pointerHasEnteredExpandedSurface = true
            return
        }

        guard pointerHasEnteredExpandedSurface else { return }
        pointerHasEnteredExpandedSurface = false
        onHoverExited?()
    }

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

    private func rectContainsIncludingEdges(_ rect: NSRect, point: NSPoint) -> Bool {
        point.x >= rect.minX
            && point.x <= rect.maxX
            && point.y >= rect.minY
            && point.y <= rect.maxY
    }
}
