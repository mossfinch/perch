import Foundation

// This file defines the catalog of guided moves and turns each move's total duration into a
// playback path of pose frames plus how long each one is held. The interface shows moves in
// catalog order and CareSessionClock advances progress along the path defined here; this
// file keeps no time, writes no care ledger, and draws no images.

/// One pose frame within a move's playback.
struct CareFrame: Equatable, Identifiable {
    let assetName: String
    let label: String
    /// Whether this is a transition between two held poses.
    /// Pass-through frames always take the short beat, and hold frames split what is left
    /// of the cycle — so passing through the neutral pose does not eat as much time as an
    /// actual stretch. The beat sound marks arriving at a held pose, not passing through a
    /// transition.
    let isPassThrough: Bool

    init(assetName: String, label: String, isPassThrough: Bool = false) {
        self.assetName = assetName
        self.label = label
        self.isPassThrough = isPassThrough
    }

    var id: String { assetName }
}

/// Each visit to a pass-through frame takes a fixed 1 second.
/// A pass-through only expresses the short beat it takes to switch sides; it does not scale
/// with the move's total duration or rep count. The remaining time goes to hold frames.
private let passThroughSeconds: TimeInterval = 1.0

/// How frames are walked within one cycle of a move.
/// - `loop`: run through in declaration order, then start the next cycle at the first frame.
/// - `pingPong`: on reaching the end, come back through the middle frames, e.g. `0, 1, 2, 1`;
///   the endpoints are not repeated at the turn. With two frames or fewer there is no
///   middle to return through, so the result matches `loop`.
enum CarePlayback: Equatable {
    case loop
    case pingPong
}

/// One playable guided move and the tempo that defines it.
/// `seconds` is the total time to complete `reps` cycles. The catalog guarantees positive
/// reps and duration, a non-empty frame list, and at least one hold frame; anyone
/// constructing a move outside the catalog must satisfy the same preconditions.
struct CareMove: Equatable, Identifiable {
    let id: String
    let category: CareCategory
    let name: String
    let reps: Int
    let seconds: Int
    let frames: [CareFrame]
    var playback: CarePlayback = .loop

    var targetReps: String { "x\(reps)" }

    /// The frame indices one cycle actually visits; `pingPong` includes the middle frames
    /// again on the way back.
    var playbackSequence: [Int] {
        switch playback {
        case .loop:
            return Array(frames.indices)
        case .pingPong:
            guard frames.count > 2 else { return Array(frames.indices) }
            return Array(frames.indices) + (1..<(frames.count - 1)).reversed()
        }
    }

    /// Seconds to complete one playback cycle.
    var cycleDuration: TimeInterval { Double(seconds) / Double(reps) }
    /// Seconds spent on this visit to frame `index`; `index` must be a valid frame index.
    /// Pass-through frames are fixed at 1 second, and hold frames split the remaining time
    /// according to how many times `playbackSequence` actually visits them — so a middle
    /// frame revisited on a `pingPong` return leg takes its own share of time.
    func frameDuration(at index: Int) -> TimeInterval {
        if frames[index].isPassThrough { return passThroughSeconds }
        let sequence = playbackSequence
        let passThroughStops = sequence.filter { frames[$0].isPassThrough }.count
        let leftForHolds = cycleDuration - Double(passThroughStops) * passThroughSeconds
        return leftForHolds / Double(sequence.count - passThroughStops)
    }
    var symbolName: String { CareMovePool.symbol(for: category) }
}

/// The catalog of moves the island can run; array order is also the paging order.
enum CareMovePool {
    /// The categories the interface currently offers. Only neck and eyes have catalog
    /// moves; until shoulders or face gain moves, do not pass them to `first` or `next`,
    /// which require a non-empty category.
    static let selectableCategories: [CareCategory] = [.neck, .eyes]

    /// The full move catalog. Moves, frames, and the computed hold durations are validated
    /// at initialization; anything that breaks the contract trips a precondition
    /// immediately rather than handing an invalid tempo to the interface or the clock.
    static let all: [CareMove] = {
        let moves = [
            CareMove(
                // The chin tuck alternates between the "align" and "start" held poses, so it
                // runs on two equal beats. Add a frame only if the move genuinely gains a
                // third pose: a plain hold frame would turn the cycle into three equal
                // stops, and only a pass-through frame introduces the one-second short beat.
                id: "chin-tuck", category: .neck, name: "Chin tuck", reps: 8, seconds: 34,
                frames: [
                    CareFrame(assetName: "CareMoveChinTuckAlign", label: "align"),
                    CareFrame(assetName: "CareMoveChinTuckStart", label: "start")
                ]
            ),
            CareMove(
                // One cycle is 20 seconds, and the round trip passes through the transition
                // frame twice at 1 second each; the left and right hold frames split the
                // remaining 18 seconds, so each side holds for 9 seconds.
                id: "neck-side-stretch", category: .neck, name: "Side-neck stretch", reps: 2, seconds: 40,
                frames: [
                    CareFrame(assetName: "CareMoveSideNeckTiltLeft", label: "tilt left"),
                    CareFrame(assetName: "CareMoveSideNeckUpright", label: "upright", isPassThrough: true),
                    CareFrame(assetName: "CareMoveSideNeckTiltRight", label: "tilt right")
                ],
                playback: .pingPong
            ),
            CareMove(
                // Same round-trip path as the side-neck stretch: 9 seconds per side, 1
                // second for each pass through the center.
                id: "levator-stretch", category: .neck, name: "Levator stretch", reps: 2, seconds: 40,
                frames: [
                    CareFrame(assetName: "CareMoveLevatorDown", label: "look down"),
                    CareFrame(assetName: "CareMoveLevatorCenter", label: "center", isPassThrough: true),
                    CareFrame(assetName: "CareMoveLevatorOther", label: "other side")
                ],
                playback: .pingPong
            ),
            CareMove(
                // Massaging left and right needs no transition pose in between; a single
                // 30-second cycle is split by two hold frames, 15 uninterrupted seconds per
                // side.
                id: "trap-massage", category: .neck, name: "Trap massage", reps: 1, seconds: 30,
                frames: [
                    CareFrame(assetName: "CareMoveTrapLeft", label: "left"),
                    CareFrame(assetName: "CareMoveTrapRight", label: "right")
                ]
            ),
            CareMove(
                // All three acupoints are hold frames, with no pass-through. Each 5-second
                // cycle is split evenly across the three frames, about 1.67 seconds per
                // point, over 8 cycles.
                id: "eye-orbital-massage", category: .eyes, name: "Eye orbital massage", reps: 8, seconds: 40,
                frames: [
                    CareFrame(assetName: "CareMoveEyeOrbitalInner", label: "inner"),
                    CareFrame(assetName: "CareMoveEyeOrbitalTemple", label: "temple"),
                    CareFrame(assetName: "CareMoveEyeOrbitalUnder", label: "under")
                ]
            )
        ]

        precondition(Set(moves.map(\.id)).count == moves.count)
        for move in moves {
            precondition(move.reps > 0 && move.seconds > 0 && !move.frames.isEmpty)
            // At least one hold frame is needed to receive the time left after the
            // pass-through beats; all-pass-through frames make frameDuration's hold-frame
            // divisor zero.
            precondition(move.frames.contains { !$0.isPassThrough })
            // The catalog only accepts frames of 0.8...30 seconds: the lower bound keeps a
            // pose from flashing by unreadably, the upper bound keeps the picture from
            // looking frozen, while still allowing 15–30 second static holds.
            for index in move.frames.indices {
                precondition((0.8...30.0).contains(move.frameDuration(at: index)))
            }
            precondition(Set(move.frames.map(\.assetName)).count == move.frames.count)
        }
        return moves
    }()

    /// Returns the first move in a category; trips preconditionFailure if the category has
    /// no moves.
    static func first(in category: CareCategory) -> CareMove {
        guard let move = all.first(where: { $0.category == category }) else {
            preconditionFailure("No care move for category \(category.rawValue)")
        }
        return move
    }

    /// Returns every move in a category; the result order is the interface's paging order.
    /// Returns an empty array when the category has no moves.
    static func moves(in category: CareCategory) -> [CareMove] {
        all.filter { $0.category == category }
    }

    /// Returns a move's zero-based position within its category, or 0 when not found.
    /// That fallback is only good for sending the interface back to the first page; it
    /// cannot be used to decide whether a move exists.
    static func index(of moveID: String, in category: CareCategory) -> Int {
        moves(in: category).firstIndex { $0.id == moveID } ?? 0
    }

    /// Returns the move after the current one in a category, wrapping to the first at the
    /// end. Trips a precondition on an empty category; returns the category's first move
    /// when `moveID` is not found.
    static func next(in category: CareCategory, after moveID: String) -> CareMove {
        let moves = all.filter { $0.category == category }
        precondition(!moves.isEmpty, "No care move for category \(category.rawValue)")
        guard let index = moves.firstIndex(where: { $0.id == moveID }) else {
            return moves[0]
        }
        return moves[(index + 1) % moves.count]
    }

    /// Returns the SF Symbol name the interface uses for a category, including categories
    /// that are not yet selectable.
    static func symbol(for category: CareCategory) -> String {
        switch category {
        case .neck:
            return "figure.stand"
        case .shoulders:
            return "figure.arms.open"
        case .eyes:
            return "eye"
        case .face:
            return "face.smiling"
        }
    }
}
