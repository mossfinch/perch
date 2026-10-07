import SwiftUI

/// How a project is spelled anywhere on this card, in one place. Both rows of
/// the top band print a project, one above the other in the same column, and
/// two spellings would read as two different kinds of thing. The agent is part
/// of the name because the dots do not encode it.
enum ProjectCaption {
    static func caption(_ project: ProjectStatus) -> String {
        "\(project.name) · \(project.source)"
    }

    /// One size for both rows' right-hand cells. They sit one above the other
    /// in the same column, where a 1pt difference reads as a different kind of
    /// thing, not as slightly smaller.
    static let font = Font.system(size: 11, weight: .medium)
}
