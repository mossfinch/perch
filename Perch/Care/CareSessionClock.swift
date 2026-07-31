import Foundation

struct CareSessionPosition: Equatable {
    let elapsed: TimeInterval
    let currentFrameIndex: Int
    let completedReps: Int
    let isComplete: Bool
}

struct CareSessionClock: Equatable {
    private(set) var accumulated: TimeInterval = 0
    private(set) var runningSince: TimeInterval?

    mutating func start(at uptime: TimeInterval) {
        accumulated = 0
        runningSince = uptime
    }

    mutating func pause(at uptime: TimeInterval) {
        guard let runningSince else { return }
        accumulated += max(0, uptime - runningSince)
        self.runningSince = nil
    }

    mutating func resume(at uptime: TimeInterval) {
        guard runningSince == nil else { return }
        runningSince = uptime
    }

    func elapsed(at uptime: TimeInterval) -> TimeInterval {
        guard let runningSince else { return accumulated }
        return accumulated + max(0, uptime - runningSince)
    }

    func position(for move: CareMove, at uptime: TimeInterval) -> CareSessionPosition {
        let elapsed = elapsed(at: uptime)
        // First locate the rep, then walk the in-cycle path (pingPong has a
        // return leg) by each frame's own duration — frames are not equal:
        // pass-throughs take the short beat.
        let cycle = move.cycleDuration
        let completedReps = Int(floor(elapsed / cycle))
        var offset = elapsed - Double(completedReps) * cycle

        let sequence = move.playbackSequence
        var frameIndex = sequence[sequence.count - 1]   // backstop: float error at the cycle's tail counts as the path's last step
        for index in sequence {
            let duration = move.frameDuration(at: index)
            if offset < duration {
                frameIndex = index
                break
            }
            offset -= duration
        }

        return CareSessionPosition(
            elapsed: elapsed,
            currentFrameIndex: frameIndex,
            completedReps: min(completedReps, move.reps),
            isComplete: elapsed >= Double(move.seconds)
        )
    }
}
