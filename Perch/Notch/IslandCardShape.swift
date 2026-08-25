import SwiftUI

/// The card background outline of the island in its opened state.
///
/// On notched screens the top shoulders taper inward to meet the physical notch; on an
/// ordinary top bar the sides stay straight. Both modes share the same bottom corners. This
/// type only produces a path within the given rect; it decides neither the window's size
/// nor the layout of its contents.
struct IslandCardShape: Shape {
    /// How the top of the card meets the edge of the screen.
    enum TopEdge: Equatable {
        /// The top keeps its full width and the sides taper inward below it, leaving a
        /// shoulder for the physical notch.
        case notch
        /// The sides run straight up to the top, for screens with no physical notch.
        case topBar
    }

    var topEdge: TopEdge
    /// How large the notch shoulder's curve is; only `.notch` mode affects the path.
    /// Callers must supply a non-negative value.
    var topCornerRadius: CGFloat = 22
    /// Radius of the bottom two corners. Callers must supply a non-negative value.
    var bottomCornerRadius: CGFloat = 22

    /// Exposes the top and bottom radii together so SwiftUI can interpolate continuously as
    /// the outline changes.
    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topCornerRadius, bottomCornerRadius) }
        set {
            topCornerRadius = newValue.first
            bottomCornerRadius = newValue.second
        }
    }

    /// Builds the closed outline within `rect`.
    /// The top inset is capped at a quarter of the width and a quarter of the height; the
    /// bottom radius is capped at a quarter of the width or half the height, so the curves
    /// on the two sides cannot cross or escape the rect.
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
