import SwiftUI

/// How a project is spelled anywhere on this card.
///
/// ⚠️ ONE place. Both rows of the top band print a project, one above the
/// other in the same column, and two spellings would read as two different
/// kinds of thing stacked on each other. The agent is part of the name, not a
/// footnote: the dots do not encode it.
enum ProjectCaption {
    static func caption(_ project: ProjectStatus) -> String {
        "\(project.name) · \(project.source)"
    }

    /// ⚠️ ONE size for both rows' right-hand cells. They sit one above the
    /// other in the same column, where a 1pt difference does not read as
    /// "slightly smaller" but as "a different kind of thing".
    static let font = Font.system(size: 11, weight: .medium)
}
