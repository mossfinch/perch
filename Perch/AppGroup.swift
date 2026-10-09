import Foundation

/// The App Group container that holds the socket, the care ledger and the
/// event log.
///
/// The code reads the id from Info.plist only. In the repo it has no Team ID
/// prefix and is the same for every builder. The entitlements declare it
/// again, and the installer checks the two agree before installing. It has its
/// own file so that finding the container does not depend on who listens on
/// the socket.
enum AppGroup {
    static let id: String = {
        let value = Bundle.main.object(forInfoDictionaryKey: "AppGroupID") as? String ?? ""
        // Two accepted shapes:
        //   group.<non-empty suffix>            the repo default, same for everyone
        //   <TeamID>.group.<non-empty suffix>   stamped in at install time
        //
        // The second shape exists because macOS 15 and later protect group
        // containers with TCC: containermanagerd lets a process through only
        // when the group id carries the signature's Team ID. A UI app can fall
        // back to a consent prompt; a faceless extension cannot prompt and gets
        // EPERM every time. The prefix never appears in the repo. The installer
        // writes it into the built product only.
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

    /// Started with `--demo` to record the island in public (see `DemoMode`). Every read and
    /// write asks `containerURL` where to go, so answering with a scratch directory is enough
    /// to keep a recording away from the real projects and the real week, and to keep demo
    /// events out of the real readings.
    static let isDemo = CommandLine.arguments.contains("--demo")

    /// Short on purpose: a Unix socket path inside it must stay under 104 bytes.
    private static let demoContainer: URL = {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pd-\(getpid())")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// Crashes when the container is unavailable instead of falling back. In a
    /// sandboxed app, a computed fallback path would quietly put the socket and
    /// the ledger in a directory nothing else can read.
    ///
    /// containerURL(forSecurityApplicationGroupIdentifier:) does not check
    /// membership; it returns a path even for a made-up id. So this guard is
    /// only a backstop. Misconfiguration is caught by the format check above
    /// and by the installer's check of the signed entitlements.
    static let containerURL: URL = {
        if isDemo { return demoContainer }
        guard let url = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: id) else {
            fatalError("Cannot get the App Group container (id=\"\(id)\"). Check that "
                       + "Perch.entitlements and Info.plist's AppGroupID agree, and that "
                       + "the group is registered.")
        }
        return url
    }()
}
