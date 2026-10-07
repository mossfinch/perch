import SwiftUI

/// The closed island's outline. Its top edge sits flush against the screen edge, so only
/// the bottom two corners are rounded.
struct IslandCapsuleShape: Shape {
    /// `nil` means half the rect's height. Must not be negative.
    var cornerRadius: CGFloat?

    /// The radius is capped at half the width so the two curves cannot cross, and at the
    /// full height: only the bottom quarter-circles are drawn, so no upper corners compete
    /// for the space.
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
