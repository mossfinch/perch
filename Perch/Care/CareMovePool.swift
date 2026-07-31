import Foundation

struct CareFrame: Equatable, Identifiable {
    let assetName: String
    let label: String
    /// Whether this is a "pass-through" pose — a transition from one side to
    /// the other, not a pose to hold. Pass-through frames get a fixed
    /// `passThroughSeconds`; hold frames split the rest of the cycle evenly.
    /// Splitting everything evenly would leave you idling in the neutral pose
    /// while the actual stretches at both ends get cut short — the rhythm
    /// should be long-quick-long.
    /// The beat sound relies on it too: a pass-through is an interval, not a
    /// new move; the tick belongs to arriving at a side.
    let isPassThrough: Bool

    init(assetName: String, label: String, isPassThrough: Bool = false) {
        self.assetName = assetName
        self.label = label
        self.isPassThrough = isPassThrough
    }

    var id: String { assetName }
}

/// A pass-through frame takes a fixed 1 second — it is the transition between
/// sides and has nothing to do with how long one cycle of the move is. A
/// beat-proportional share would drift whenever reps or total duration
/// change; a fixed duration cannot.
private let passThroughSeconds: TimeInterval = 1.0

/// How frames advance within one cycle.
/// - `loop`: go around and back to the start. The eye-orbital massage walks a
///   circle around the eye, and chin tuck's jut-to-tuck IS the direction of
///   the move — last frame into first frame is continuous.
/// - `pingPong`: swing out and back (left→center→right→center→left). The
///   neutral pose is on the way; jumping from the last frame straight back to
///   the first swallows the return trip, and the session feels like a hard
///   yank from one side to the other.
enum CarePlayback: Equatable {
    case loop
    case pingPong
}

struct CareMove: Equatable, Identifiable {
    let id: String
    let category: CareCategory
    let name: String
    let reps: Int
    let seconds: Int
    let frames: [CareFrame]
    var playback: CarePlayback = .loop

    var targetReps: String { "x\(reps)" }

    /// Frame indices actually visited in one cycle. pingPong revisits the
    /// middle frames on the way back.
    var playbackSequence: [Int] {
        switch playback {
        case .loop:
            return Array(frames.indices)
        case .pingPong:
            guard frames.count > 2 else { return Array(frames.indices) }
            return Array(frames.indices) + (1..<(frames.count - 1)).reversed()
        }
    }

    /// Duration of one cycle (one full pass of playbackSequence)
    var cycleDuration: TimeInterval { Double(seconds) / Double(reps) }
    /// How long each visit to frame `index` lasts.
    /// Pass-through frames are fixed at 1 second; hold frames split the rest
    /// of the cycle. Counted over the path actually walked — frames revisited
    /// on a pingPong return leg count once per visit, or the return trip
    /// would get no time at all.
    func frameDuration(at index: Int) -> TimeInterval {
        if frames[index].isPassThrough { return passThroughSeconds }
        let sequence = playbackSequence
        let passThroughStops = sequence.filter { frames[$0].isPassThrough }.count
        let leftForHolds = cycleDuration - Double(passThroughStops) * passThroughSeconds
        return leftForHolds / Double(sequence.count - passThroughStops)
    }
    var symbolName: String { CareMovePool.symbol(for: category) }
}

enum CareMovePool {
    static let selectableCategories: [CareCategory] = [.neck, .eyes]

    static let all: [CareMove] = {
        let moves = [
            CareMove(
                // The real move just alternates tucked-aligned ↔ neutral — a
                // two-beat tick-tock. Do not add a third frame: the cycle
                // becomes long-long-short and two adjacent long beats cannot
                // be counted.
                id: "chin-tuck", category: .neck, name: "Chin tuck", reps: 8, seconds: 34,
                frames: [
                    CareFrame(assetName: "CareMoveChinTuckAlign", label: "align"),
                    CareFrame(assetName: "CareMoveChinTuckStart", label: "start")
                ]
            ),
            CareMove(
                // A stretch only works if you stay IN it: 2 reps = 9s per
                // side. More reps make each side too short — barely into the
                // stretch and it's time to switch (pump-style chin tuck is
                // the opposite: fast is right).
                id: "neck-side-stretch", category: .neck, name: "Side-neck stretch", reps: 2, seconds: 40,
                frames: [
                    CareFrame(assetName: "CareMoveSideNeckTiltLeft", label: "tilt left"),
                    CareFrame(assetName: "CareMoveSideNeckUpright", label: "upright", isPassThrough: true),
                    CareFrame(assetName: "CareMoveSideNeckTiltRight", label: "tilt right")
                ],
                playback: .pingPong
            ),
            CareMove(
                // Also a stretch; same tempo as the side-neck: hold 9s per side, 1s through center
                id: "levator-stretch", category: .neck, name: "Levator stretch", reps: 2, seconds: 40,
                frames: [
                    CareFrame(assetName: "CareMoveLevatorDown", label: "look down"),
                    CareFrame(assetName: "CareMoveLevatorCenter", label: "center", isPassThrough: true),
                    CareFrame(assetName: "CareMoveLevatorOther", label: "other side")
                ],
                playback: .pingPong
            ),
            CareMove(
                // A massage has no "center" station: after the left shoulder
                // you switch hands directly, you don't return to neutral
                // first. Kneading needs room to work: 1 rep = 15s per side in
                // one go; more reps leave each side too short to knead.
                id: "trap-massage", category: .neck, name: "Trap massage", reps: 1, seconds: 30,
                frames: [
                    CareFrame(assetName: "CareMoveTrapLeft", label: "left"),
                    CareFrame(assetName: "CareMoveTrapRight", label: "right")
                ]
            ),
            CareMove(
                // Three acupoints in a circle around the eye socket — all
                // real stations, no pass-through, so the three frames split
                // evenly. The eye area is a light circling touch, unlike the
                // traps: 8 reps = 1.7s per point (8 laps).
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
            // At least one hold frame: if every frame is pass-through, nobody
            // splits the remaining time (frameDuration divides by zero).
            precondition(move.frames.contains { !$0.isPassThrough })
            // Per-frame backstop: the fastest pass-through must still be
            // readable (≥0.8s), the slowest hold must not look frozen (≤30s).
            // The upper bound must leave room for static stretches — 15–30s
            // per side is what a stretch takes; don't tighten it to
            // pump-style moves.
            for index in move.frames.indices {
                precondition((0.8...30.0).contains(move.frameDuration(at: index)))
            }
            precondition(Set(move.frames.map(\.assetName)).count == move.frames.count)
        }
        return moves
    }()

    static func first(in category: CareCategory) -> CareMove {
        guard let move = all.first(where: { $0.category == category }) else {
            preconditionFailure("No care move for category \(category.rawValue)")
        }
        return move
    }

    /// Moves in a category (order = paging order). The view draws the
    /// "which one of how many" ring from it.
    static func moves(in category: CareCategory) -> [CareMove] {
        all.filter { $0.category == category }
    }

    /// Position of the move within its category (0 if not found).
    static func index(of moveID: String, in category: CareCategory) -> Int {
        moves(in: category).firstIndex { $0.id == moveID } ?? 0
    }

    static func next(in category: CareCategory, after moveID: String) -> CareMove {
        let moves = all.filter { $0.category == category }
        precondition(!moves.isEmpty, "No care move for category \(category.rawValue)")
        guard let index = moves.firstIndex(where: { $0.id == moveID }) else {
            return moves[0]
        }
        return moves[(index + 1) % moves.count]
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
