/// The presentation the island is currently aiming for.
///
/// The view picks the closed capsule or the opened card from it, and the window controller
/// switches mouse interaction on it. This type describes neither the animation in between,
/// nor the agent's working state, nor the care session's state; those rules belong to their
/// own callers.
public enum IslandPresentationPhase: Equatable, Sendable {
    /// Show the closed capsule hugging the top edge of the screen.
    case closed
    /// Show the opened card and let the window receive mouse events.
    case opened
}
