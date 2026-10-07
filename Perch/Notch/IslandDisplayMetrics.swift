import CoreGraphics

/// The island window's geometry on one screen, in macOS logical points.
/// `IslandWindowController` derives it; window placement, SwiftUI layout and the hover zones
/// read it.
public struct IslandDisplayMetrics: Equatable, Sendable {
    public let isNotched: Bool
    /// Includes the transparent shadow margins.
    public let windowWidth: CGFloat
    /// Includes the bottom shadow margin.
    public let windowHeight: CGFloat
    public let closedWidth: CGFloat
    /// Also the safe-area height at the top of the opened card.
    public let closedHeight: CGFloat
    /// The transparent gap in the closed capsule's centre that lines up with the physical
    /// notch; 0 without one.
    public let notchGapWidth: CGFloat
    /// What the opened content asks for; `layoutWidth` is the larger of this and
    /// `closedWidth`.
    public let resultWidth: CGFloat
    /// Below the top safe area.
    public let resultHeight: CGFloat
    /// The card itself, without shadow margins; it fits both the capsule and the opened
    /// content.
    public let layoutWidth: CGFloat
    /// `closedHeight + resultHeight`, without shadow margins.
    public let layoutHeight: CGFloat
    /// On each side; the window width includes two.
    public let openedShadowHorizontalInset: CGFloat
    public let openedShadowBottomInset: CGFloat

    /// Nothing is clamped or derived. Callers supply non-negative dimensions that keep these
    /// relationships:
    /// `layoutWidth >= closedWidth` and `layoutWidth >= resultWidth`,
    /// `layoutHeight = closedHeight + resultHeight`,
    /// `windowWidth = layoutWidth + 2 × openedShadowHorizontalInset`,
    /// `windowHeight = layoutHeight + openedShadowBottomInset`.
    public init(
        isNotched: Bool,
        windowWidth: CGFloat,
        windowHeight: CGFloat,
        closedWidth: CGFloat,
        closedHeight: CGFloat,
        notchGapWidth: CGFloat,
        resultWidth: CGFloat,
        resultHeight: CGFloat,
        layoutWidth: CGFloat,
        layoutHeight: CGFloat,
        openedShadowHorizontalInset: CGFloat,
        openedShadowBottomInset: CGFloat
    ) {
        self.isNotched = isNotched
        self.windowWidth = windowWidth
        self.windowHeight = windowHeight
        self.closedWidth = closedWidth
        self.closedHeight = closedHeight
        self.notchGapWidth = notchGapWidth
        self.resultWidth = resultWidth
        self.resultHeight = resultHeight
        self.layoutWidth = layoutWidth
        self.layoutHeight = layoutHeight
        self.openedShadowHorizontalInset = openedShadowHorizontalInset
        self.openedShadowBottomInset = openedShadowBottomInset
    }

    /// Startup values, used until the controller picks a screen and measures it. They only
    /// need to be self-consistent and displayable; they describe no real screen.
    public static let fallback = IslandDisplayMetrics(
        isNotched: false,
        windowWidth: 556,
        windowHeight: 164,
        closedWidth: 340,
        closedHeight: 38,
        notchGapWidth: 0,
        resultWidth: 520,
        resultHeight: 104,
        layoutWidth: 520,
        layoutHeight: 142,
        openedShadowHorizontalInset: 18,
        openedShadowBottomInset: 22
    )
}
