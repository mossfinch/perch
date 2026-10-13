import Foundation

/// The one folder that holds the socket, the care ledger and the event log:
/// `~/.perch/island/`.
///
/// It used to be an App Group container. A download is ad-hoc signed, and
/// macOS 26 treats an ad-hoc app's group container as another app's data: it
/// asked "would like to access data from other apps" on every launch, never
/// remembered the answer, and after "Don't Allow" the socket never bound and
/// every hook event was lost without a word. A folder in the user's home needs
/// no group: the entitlements already grant `~/.perch/`, and one sandbox rule
/// lets the socket bind in this folder and nowhere else.
///
/// `~/.perch/island`, not `~/.perch`: the reconciler already writes
/// `canonical-turns.jsonl` and `source-health.json` into
/// `~/.perch/reconciliation`, the same names the island publishes.
enum DataHome {
    /// Started with `--demo` to record the island in public (see `DemoMode`). Every read and
    /// write asks `url` where to go, so answering with a scratch directory is enough
    /// to keep a recording away from the real projects and the real week, and to keep demo
    /// events out of the real readings.
    static let isDemo = CommandLine.arguments.contains("--demo")

    /// Short on purpose: a Unix socket path inside it must stay under 104 bytes.
    private static let demoDirectory: URL = {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pd-\(getpid())")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// The user's real home. Crashes rather than fall back: inside the sandbox
    /// `NSHomeDirectory()` is the app's own container, and a socket and a
    /// ledger put there would be in a folder no hook and no reader can reach,
    /// without a sound.
    static var realHome: String {
        guard let entry = getpwuid(getuid()) else {
            fatalError("Cannot read this user's home directory (getpwuid failed), so there is no ~/.perch/island.")
        }
        return String(cString: entry.pointee.pw_dir)
    }

    /// Owner-only, like `~/.claude` and like the group container it replaced:
    /// project paths and working hours are nobody else's business, and
    /// `~/.perch` itself is world-readable. Set every launch, not just on
    /// creation, so a folder made some other way is tightened too. Whether it
    /// worked is `privacyProblem`'s job, not a `try?` that hopes.
    static let url: URL = {
        if isDemo { return demoDirectory }
        let url = URL(fileURLWithPath: realHome).appendingPathComponent(".perch/island", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }()

    /// Why `url` cannot be trusted with private data, or nil when it can. Checked
    /// once, after `url` has tried to make it private. The socket refuses to open
    /// while this is not nil, so nothing an agent sends is recorded in a folder
    /// another account can read, and the card says why.
    static let privacyProblem: String? = isDemo ? nil : privacyProblem(at: url.path)

    static func privacyProblem(at path: String) -> String? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else {
            return "~/.perch/island cannot be opened"
        }
        if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
            return "~/.perch/island is a link to somewhere else"
        }
        if (attributes[.ownerAccountID] as? NSNumber)?.uint32Value != getuid() {
            return "~/.perch/island belongs to another account"
        }
        let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777
        if mode & 0o077 != 0 {
            return "~/.perch/island can be read by other accounts"
        }
        return nil
    }
}
