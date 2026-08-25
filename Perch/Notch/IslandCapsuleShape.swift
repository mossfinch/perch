import SwiftUI

/// The background outline of the island in its closed state.
///
/// The path's top edge sits flush against the edge of the screen, so the top edge and both
/// upper corners stay straight and only the bottom two corners are rounded. This type only
/// produces a path within the given rect; it decides neither the capsule's size, nor its
/// position on screen, nor the layout of anything inside it.
struct IslandCapsuleShape: Shape {
    /// Radius of the bottom corners. When `nil`, half the rect's height is used; callers
    /// must supply a non-negative value.
    var cornerRadius: CGFloat?

    /// Builds the closed outline within `rect`.
    /// The radius is capped at half the width so the left and right curves cannot cross,
    /// and at the full height. Using the whole height rather than half is possible here
    /// because only the bottom quarter-circles are drawn — there is no second set of
    /// corners above competing for the space.
    func path(in rect: CGRect) -> Path {
        let radius = min(cornerRadius ?? rect.height / 2, rect.width / 2, rect.height)

        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - radius))
        path.addArc(
            center: CGPoint(x: rect.maxX - radius, y: rect.maxY - radius),
            radius: radius,
            startAngle: .degrees(0),
            endAngle: .degrees(90),
            clockwise: false
        )
        path.addLine(to: CGPoint(x: rect.minX + radius, y: rect.maxY))
        path.addArc(
            center: CGPoint(x: rect.minX + radius, y: rect.maxY - radius),
            radius: radius,
            startAngle: .degrees(90),
            endAngle: .degrees(180),
            clockwise: false
        )
        path.closeSubpath()
        return path
    }
}
