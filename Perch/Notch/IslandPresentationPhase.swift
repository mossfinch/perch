/// The presentation the island is aiming for. The view picks the capsule or the card from
/// it, and the window controller switches mouse interaction on it.
public enum IslandPresentationPhase: Equatable, Sendable {
    case closed
    /// The window receives mouse events only in this phase.
    case opened
}
