import Foundation

/// The island's App Group container id — the socket, the care ledger, and the
/// event log all live in this container.
///
/// The value is hard-coded in Info.plist (no Team ID prefix, identical for
/// every builder). Code reads Info.plist and nothing else; the duplicate
/// declaration in the entitlements is checked against it by the installer
/// before install. Kept in its own file so that "who needs the container"
/// does not depend on "who listens on the socket".
enum AppGroup {
    static let id: String = {
        let value = Bundle.main.object(forInfoDictionaryKey: "AppGroupID") as? String ?? ""
        // Must look like group.<non-empty suffix>
        guard value.hasPrefix("group."), value.count > "group.".count else {
            fatalError("Invalid AppGroupID in Info.plist (got \"\(value)\"), expected group.xxx.")
        }
        return value
    }()

    /// The container directory. Crash on the spot if unavailable, never fall
    /// back — in a sandboxed app, any self-computed fallback path silently
    /// sends the socket and the ledger into a shadow directory nothing else
    /// can read.
    ///
    /// Note: macOS's containerURL(forSecurityApplicationGroupIdentifier:)
    /// does NOT validate membership — it returns a path even for a made-up
    /// id, so this guard is only a backstop. What actually catches
    /// misconfiguration is the format check above plus the installer's
    /// check of the signed entitlements.
    static let containerURL: URL = {
        guard let url = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: id) else {
            fatalError("Cannot get the App Group container (id=\"\(id)\"). Check that "
                       + "Perch.entitlements and Info.plist's AppGroupID agree, and that "
                       + "the group is registered.")
        }
        return url
    }()
}
