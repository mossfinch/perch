import SwiftUI

/// The opened card's outline. On a notched screen the top shoulders taper inward to meet
/// the physical notch; under an ordinary top bar the sides stay straight.
struct IslandCardShape: Shape {
    enum TopEdge: Equatable {
        case notch
        case topBar
    }

    var topEdge: TopEdge
    /// Used by `.notch` only. Neither radius may be negative.
    var topCornerRadius: CGFloat = 22
    var bottomCornerRadius: CGFloat = 22

    /// Both radii, so SwiftUI can animate the outline continuously.
    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topCornerRadius, bottomCornerRadius) }
        set {
            topCornerRadius = newValue.first
            bottomCornerRadius = newValue.second
        }
    }

    /// The top inset is capped at a quarter of the width and of the height, the bottom
    /// radius at a quarter of the width or half the height, so the curves on the two sides
    /// cannot cross or leave the rect.
    func path(in rect: CGRect) -> Path {
        let topInset = topEdge == .notch
            ? min(topCornerRadius, rect.width / 4, rect.height / 4)
            : 0
        let bottomRadius = min(bottomCornerRadius, rect.width / 4, rect.height / 2)

        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))

        if topInset > 0 {
            path.addQuadCurve(
                to: CGPoint(x: rect.minX + topInset, y: rect.minY + topInset),
                control: CGPoint(x: rect.minX + topInset, y: rect.minY)
            )
        }

        path.addLine(to: CGPoint(x: rect.minX + topInset, y: rect.maxY - bottomRadius))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + topInset + bottomRadius, y: rect.maxY),
            control: CGPoint(x: rect.minX + topInset, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.maxX - topInset - bottomRadius, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - topInset, y: rect.maxY - bottomRadius),
            control: CGPoint(x: rect.maxX - topInset, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.maxX - topInset, y: rect.minY + topInset))

        if topInset > 0 {
            path.addQuadCurve(
                to: CGPoint(x: rect.maxX, y: rect.minY),
                control: CGPoint(x: rect.maxX - topInset, y: rect.minY)
            )
        } else {
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        }

        path.closeSubpath()
        return path
    }
}

/// The island's one black ground, at any point between closed and opened.
///
/// `progress` 0 is exactly the closed capsule (`IslandCapsuleShape`), 1 exactly the opened card
/// (`IslandCardShape`); in between, a card shape whose size and corners are interpolated, kept
/// centred under the top edge so it grows out of the notch rather than out of a corner. The
/// rect it is given is the opened card's; the closed size is passed in.
///
/// The two ends use their own shapes so that both resting states draw exactly what they drew
/// before. The in-between frames use quadratic corners where the capsule uses circular ones;
/// at the closed end that is about 1pt at each lower corner, on the last frame of a close.
struct IslandMorphShape: Shape {
    var progress: CGFloat
    let closedSize: CGSize
    let topEdge: IslandCardShape.TopEdge
    /// False when the system asks for reduced motion: the outline then jumps to its target
    /// instead of travelling there, and only the contents fade.
    let travels: Bool

    var animatableData: CGFloat {
        get { progress }
        set { if travels { progress = newValue } }
    }

    func path(in rect: CGRect) -> Path {
        let p = progress
        let width = closedSize.width + (rect.width - closedSize.width) * p
        let height = closedSize.height + (rect.height - closedSize.height) * p
        let frame = CGRect(x: rect.midX - width / 2, y: rect.minY, width: width, height: height)

        if p <= 0 {
            return IslandCapsuleShape(cornerRadius: closedSize.height / 2).path(in: frame)
        }
        let card = IslandCardShape(topEdge: topEdge)
        if p >= 1 {
            return card.path(in: frame)
        }
        let closedRadius = closedSize.height / 2
        return IslandCardShape(
            topEdge: topEdge,
            topCornerRadius: card.topCornerRadius * p,
            bottomCornerRadius: closedRadius + (card.bottomCornerRadius - closedRadius) * p
        ).path(in: frame)
    }
}
