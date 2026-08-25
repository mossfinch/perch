import Foundation

// This file computes a guided session's effective elapsed time and move progress from the
// monotonic system uptime. Callers are responsible for sampling, scheduling refreshes, and
// handling completion; nothing here creates a Timer, reads the date, or writes the ledger.
//
// Every `uptime` argument must come from the same time base, e.g.
// `ProcessInfo.processInfo.systemUptime`. Do not pass `Date` timestamps: a wall clock jumps
// when the user changes the system time or time zone, which would break session timing.

/// A snapshot of session progress at one sampled instant.
struct CareSessionPosition: Equatable {
    /// Accumulated seconds with paused time excluded.
    let elapsed: TimeInterval
    /// Index into `CareMove.frames` of the frame currently shown.
    let currentFrameIndex: Int
    /// Cycles completed, capped at the move's required `reps`.
    let completedReps: Int
    /// Whether the accumulated seconds have reached the move's total duration.
    let isComplete: Bool
}

/// A value-type session clock that can be paused and resumed.
/// It stores only the accumulated seconds and the start of the current run; elapsed time is
/// derived entirely from the uptime the caller passes in, so a late refresh never
/// undercounts time.
struct CareSessionClock: Equatable {
    private(set) var accumulated: TimeInterval = 0
    private(set) var runningSince: TimeInterval?

    /// Starts a new session at the given uptime, clearing any previously accumulated time.
    mutating func start(at uptime: TimeInterval) {
        accumulated = 0
        runningSince = uptime
    }

    /// Pauses at the given uptime; does nothing if already paused.
    /// An out-of-order sample earlier than the current run's start counts as zero elapsed
    /// time — it must never subtract from what has already accumulated.
    mutating func pause(at uptime: TimeInterval) {
        guard let runningSince else { return }
        accumulated += max(0, uptime - runningSince)
        self.runningSince = nil
    }

    /// Resumes accumulating from the given uptime; does not reset the start point while
    /// still running.
    mutating func resume(at uptime: TimeInterval) {
        guard runningSince == nil else { return }
        runningSince = uptime
    }

    /// Returns the effective accumulated seconds at the given uptime without changing the
    /// clock's state.
    /// While paused it returns the fixed accumulated value; while running, an out-of-order
    /// sample that moves backwards likewise counts as zero elapsed time.
    func elapsed(at uptime: TimeInterval) -> TimeInterval {
        guard let runningSince else { return accumulated }
        return accumulated + max(0, uptime - runningSince)
    }

    /// Converts effective elapsed time into a move frame, a completed-cycle count, and a
    /// completion flag.
    /// `move` must satisfy `CareMove`'s tempo preconditions: positive reps, a non-empty
    /// frame list, and frame durations that cover a whole cycle.
    ///
    /// Once complete, `completedReps` is capped and `isComplete` is true; `elapsed` and the
    /// current frame still follow the sample time passed in. A caller that wants the end
    /// state frozen should stop refreshing once it sees completion.
    func position(for move: CareMove, at uptime: TimeInterval) -> CareSessionPosition {
        let elapsed = elapsed(at: uptime)
        // Locate the cycle first, then walk the actual playback path subtracting each
        // visit's own frame duration; pingPong includes the return leg, and pass-through
        // frames can be shorter than hold frames, so time cannot be split evenly by frame
        // count.
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
