import CoreGraphics

public struct IslandDisplayMetrics: Equatable, Sendable {
    public let isNotched: Bool
    public let windowWidth: CGFloat
    public let windowHeight: CGFloat
    public let closedWidth: CGFloat
    public let closedHeight: CGFloat
    public let notchGapWidth: CGFloat
    public let resultWidth: CGFloat
    public let resultHeight: CGFloat
    public let layoutWidth: CGFloat
    public let layoutHeight: CGFloat
    public let openedShadowHorizontalInset: CGFloat
    public let openedShadowBottomInset: CGFloat

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
