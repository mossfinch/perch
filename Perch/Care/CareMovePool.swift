import Foundation

// The catalog of guided moves, and how each move's total duration becomes a playback path
// of pose frames with a hold time for each. The interface shows moves in catalog order, and
// CareSessionClock advances along the path defined here.

struct CareFrame: Equatable, Identifiable {
    let assetName: String
    let label: String
    /// A transition between two held poses. Pass-through frames always take the short beat
    /// and hold frames split what is left of the cycle, so passing through the neutral pose
    /// does not take as long as an actual stretch. The beat sound marks arriving at a held
    /// pose, not passing through a transition.
    let isPassThrough: Bool

    init(assetName: String, label: String, isPassThrough: Bool = false) {
        self.assetName = assetName
        self.label = label
        self.isPassThrough = isPassThrough
    }

    var id: String { assetName }
}

/// A pass-through is the short beat it takes to switch sides, so it does not scale with the
/// move's duration or rep count. Hold frames get the rest.
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

/// `seconds` is the total time for `reps` cycles. The catalog guarantees positive reps and
/// duration, a non-empty frame list, and at least one hold frame; a move built outside the
/// catalog must meet the same preconditions.
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

    var cycleDuration: TimeInterval { Double(seconds) / Double(reps) }
    /// Seconds for one visit to frame `index`. Hold frames split the time left after the
    /// pass-throughs by how often `playbackSequence` visits them, so a middle frame revisited
    /// on a `pingPong` return leg takes its own share.
    func frameDuration(at index: Int) -> TimeInterval {
        if frames[index].isPassThrough { return passThroughSeconds }
        let sequence = playbackSequence
        let passThroughStops = sequence.filter { frames[$0].isPassThrough }.count
        let leftForHolds = cycleDuration - Double(passThroughStops) * passThroughSeconds
        return leftForHolds / Double(sequence.count - passThroughStops)
    }
    var symbolName: String { CareMovePool.symbol(for: category) }
}

/// The moves the island can run. Array order is the paging order and the order the card
/// offers them in.
enum CareMovePool {
    /// The categories the interface currently offers. Only neck and eyes have catalog
    /// moves; until shoulders or face gain moves, do not pass them to `first` or `next`,
    /// which require a non-empty category.
    static let selectableCategories: [CareCategory] = [.neck, .eyes]

    /// Validated when first built: anything that breaks the contract trips a precondition at
    /// once instead of handing an invalid tempo to the interface or the clock.
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

    /// Traps when the category has no moves.
    static func first(in category: CareCategory) -> CareMove {
        guard let move = all.first(where: { $0.category == category }) else {
            preconditionFailure("No care move for category \(category.rawValue)")
        }
        return move
    }

    static func moves(in category: CareCategory) -> [CareMove] {
        all.filter { $0.category == category }
    }

    /// 0 when not found. That fallback only sends the interface back to the first page; it
    /// cannot tell whether a move exists.
    static func index(of moveID: String, in category: CareCategory) -> Int {
        moves(in: category).firstIndex { $0.id == moveID } ?? 0
    }

    /// Wraps to the first move at the end, and starts there when `moveID` is not found.
    /// Traps on an empty category.
    static func next(in category: CareCategory, after moveID: String) -> CareMove {
        let moves = all.filter { $0.category == category }
        precondition(!moves.isEmpty, "No care move for category \(category.rawValue)")
        guard let index = moves.firstIndex(where: { $0.id == moveID }) else {
            return moves[0]
        }
        return moves[(index + 1) % moves.count]
    }

    /// The move after `moveID` in catalog order across every category, wrapping at the end.
    /// Nil, or an id the catalog no longer carries, starts at the top. The card offers this
    /// one next: the move after the last one done.
    static func next(after moveID: String?) -> CareMove {
        guard let moveID, let index = all.firstIndex(where: { $0.id == moveID }) else {
            return all[0]
        }
        return all[(index + 1) % all.count]
    }

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
