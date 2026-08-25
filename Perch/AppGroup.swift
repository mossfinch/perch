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
        // Two accepted shapes:
        //   group.<non-empty suffix>            — the repo default, same for everyone
        //   <TeamID>.group.<non-empty suffix>   — stamped in at install time
        //
        // ⚠️ The second shape exists because macOS 15+ TCC-protects group
        // containers: containermanagerd only waves a process through when the
        // group id carries the signature's Team ID. A UI app can fall back to a
        // consent prompt, but a faceless extension cannot prompt and gets EPERM
        // forever. The prefix never appears in the repo — the installer injects
        // it into the BUILT product only.
        let isPlain = value.hasPrefix("group.") && value.count > "group.".count
        let isTeamPrefixed: Bool = {
            guard let dot = value.firstIndex(of: ".") else { return false }
            let team = value[value.startIndex..<dot]
            let rest = String(value[value.index(after: dot)...])
            return !team.isEmpty && rest.hasPrefix("group.") && rest.count > "group.".count
        }()
        guard isPlain || isTeamPrefixed else {
            fatalError("Invalid AppGroupID in Info.plist (got \"\(value)\"), expected group.xxx or TEAMID.group.xxx.")
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
