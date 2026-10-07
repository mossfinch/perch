import Foundation

// A guided session's elapsed time and move progress, computed from the monotonic system
// uptime. The caller samples it and schedules the refreshes; nothing here owns a Timer.
//
// Every `uptime` argument must come from the same time base, such as
// `ProcessInfo.processInfo.systemUptime`. Do not pass `Date` timestamps: a wall clock jumps
// when the user changes the system time or time zone, which would break session timing.

struct CareSessionPosition: Equatable {
    /// Paused time excluded.
    let elapsed: TimeInterval
    /// Index into `CareMove.frames`.
    let currentFrameIndex: Int
    /// Capped at the move's `reps`.
    let completedReps: Int
    let isComplete: Bool
}

/// A session clock that can be paused and resumed. Elapsed time is derived from the uptime
/// the caller passes in, never counted per refresh, so a late refresh never undercounts.
struct CareSessionClock: Equatable {
    private(set) var accumulated: TimeInterval = 0
    private(set) var runningSince: TimeInterval?

    mutating func start(at uptime: TimeInterval) {
        accumulated = 0
        runningSince = uptime
    }

    /// A sample earlier than the run's start counts as zero: it must never subtract from
    /// what has already accumulated.
    mutating func pause(at uptime: TimeInterval) {
        guard let runningSince else { return }
        accumulated += max(0, uptime - runningSince)
        self.runningSince = nil
    }

    mutating func resume(at uptime: TimeInterval) {
        guard runningSince == nil else { return }
        runningSince = uptime
    }

    /// As in `pause`, a sample from before the run's start adds nothing.
    func elapsed(at uptime: TimeInterval) -> TimeInterval {
        guard let runningSince else { return accumulated }
        return accumulated + max(0, uptime - runningSince)
    }

    /// `move` must meet `CareMove`'s tempo preconditions: positive reps, a non-empty frame
    /// list, and frame durations that cover a whole cycle.
    ///
    /// Once complete, `completedReps` stays capped, but `elapsed` and the current frame still
    /// follow the sample time. A caller that wants the end state frozen stops refreshing at
    /// completion.
    func position(for move: CareMove, at uptime: TimeInterval) -> CareSessionPosition {
        let elapsed = elapsed(at: uptime)
        // Find the cycle, then walk the real playback path, subtracting each visit's own
        // duration. The ping-pong path includes the return leg, and pass-through frames are
        // shorter than holds, so time cannot be split evenly by frame count.
        let cycle = move.cycleDuration
        let completedReps = Int(floor(elapsed / cycle))
        var offset = elapsed - Double(completedReps) * cycle

        let sequence = move.playbackSequence
        // If floating-point residue leaves offset outside every half-open interval, it
        // falls back to the cycle's last step.
        var frameIndex = sequence[sequence.count - 1]
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
