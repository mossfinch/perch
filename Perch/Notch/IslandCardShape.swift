import SwiftUI

struct IslandCardShape: Shape {
    enum TopEdge: Equatable {
        case notch
        case topBar
    }

    var topEdge: TopEdge
    var topCornerRadius: CGFloat = 22
    var bottomCornerRadius: CGFloat = 22

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topCornerRadius, bottomCornerRadius) }
        set {
            topCornerRadius = newValue.first
            bottomCornerRadius = newValue.second
        }
    }

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
