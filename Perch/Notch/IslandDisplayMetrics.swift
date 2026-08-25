import CoreGraphics

/// A geometry snapshot of the island window and its visible contents on one target screen.
///
/// `IslandWindowController` derives these values from the current screen, and window
/// placement, SwiftUI layout, and the hover zones all read them. Every dimension is in
/// macOS logical points. This type only carries the numbers; it does not read the screen or
/// validate the relationships between its fields.
public struct IslandDisplayMetrics: Equatable, Sendable {
    /// Whether the target screen is laid out around a physical notch.
    public let isNotched: Bool
    /// Full width of the NSPanel, including the transparent margins for the shadow.
    public let windowWidth: CGFloat
    /// Full height of the NSPanel, including the bottom margin for the shadow.
    public let windowHeight: CGFloat
    /// Visible width of the closed capsule.
    public let closedWidth: CGFloat
    /// Visible height of the closed capsule, which is also the safe-area height at the top
    /// of the opened card.
    public let closedHeight: CGFloat
    /// On notched screens, the transparent gap at the center of the closed capsule that
    /// lines up with the physical notch; 0 on ordinary screens.
    public let notchGapWidth: CGFloat
    /// The width the opened content would like; the controller takes the larger of this and
    /// `closedWidth` to produce `layoutWidth`.
    public let resultWidth: CGFloat
    /// Content height of the opened card below the top safe area.
    public let resultHeight: CGFloat
    /// Actual card width before the shadow margins, which must fit both the closed capsule
    /// and the opened content.
    public let layoutWidth: CGFloat
    /// Actual card height before the shadow margins, i.e. `closedHeight + resultHeight`.
    public let layoutHeight: CGFloat
    /// Transparent width reserved for the shadow on each side of the card; the window's
    /// total width includes two of them.
    public let openedShadowHorizontalInset: CGFloat
    /// Transparent height reserved for the shadow below the card.
    public let openedShadowBottomInset: CGFloat

    /// Creates a complete geometry snapshot.
    ///
    /// The initializer neither clamps nor derives values. Callers should supply
    /// non-negative dimensions and maintain these relationships:
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

    /// Notch-free startup values used before the target screen's geometry is available.
    /// They create the initial window and populate the initial view model; once the
    /// controller has picked a screen, measured results replace them. These numbers only
    /// need to form a self-consistent, displayable startup layout — they do not stand for
    /// any real screen's dimensions.
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
