import Foundation

/// Wires Claude Code and codex to Perch from inside the app, for people who downloaded it
/// and have no copy of the Python installers.
///
/// This is a port of `install-island-hooks.py` and `install-codex-island-hooks.py`, and those
/// stay the reference: given the same files, both must write the same bytes, and a test holds
/// them to it. Their comments carry the reasons behind each rule; only what differs here is
/// explained here.
///
/// What differs, and why:
/// - Everything is read and checked before anything is written. A config this code cannot
///   read leaves every file as it was.
/// - Only an agent whose folder exists is wired. The app is the one doing the asking, so a
///   missing `~/.claude` means Claude Code is not installed, not that its folder is missing.
/// - The launcher is a symbolic link into the app instead of a copy. macOS marks every file a
///   sandboxed app writes as quarantined, and a quarantined script refuses to run ("bad
///   interpreter: Operation not permitted"). The hooks fail open, so that would be a bird
///   that never moves and no error anywhere. A link the app writes still runs the script the
///   app shipped.
/// - codex's completion bell in the notify script is left alone. That script is a particular
///   machine's own chain; on a fresh Mac it does not exist and the Python installer skips it
///   too.
enum HookSetup {
    /// Python's `EVENTS`, in the same order: the order is the order hooks are written.
    static let events: [(name: String, word: String)] = [
        ("UserPromptSubmit", "working"),
        ("PermissionRequest", "waiting"),
        ("PostToolUse", "working"),
        ("Stop", "complete"),
    ]

    /// Where the hook launcher looks for the app. `perch-hook.sh` reads the App Group from
    /// this exact path, so an app running from anywhere else would wire hooks to nothing.
    static let installedApp = "/Applications/Perch.app"

    enum Status: Equatable {
        /// Every agent on this Mac is wired, or none is installed.
        case ready
        case needsConnect
        case notInApplications
        case failed(String)
    }

    struct Report: Equatable {
        /// codex skips a changed hook until someone trusts it in its own `/hooks` panel.
        var codexNeedsTrust: Bool
    }

    struct SetupError: Error, CustomStringConvertible {
        let description: String
    }

    /// The paths one setup works on. Tests point `home` at a fixture.
    struct Paths {
        let home: String
        /// The script the launcher link points at: the copy inside the installed app.
        let launcherTarget: String

        var claudeDir: String { home + "/.claude" }
        var claudeSettings: String { claudeDir + "/settings.json" }
        var codexDir: String { home + "/.codex" }
        var codexHooks: String { codexDir + "/hooks.json" }
        var launcher: String { home + "/.perch/bin/perch-hook" }

        func command(_ word: String, _ source: String) -> String {
            "'\(launcher)' \(word) \(source)"
        }

        /// The user's real home. Inside the sandbox `NSHomeDirectory()` is the app's container.
        static func forThisMac(bundle: Bundle = .main) -> Paths {
            let home = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
            let target = bundle.path(forResource: "perch-hook", ofType: "sh")
                ?? installedApp + "/Contents/Resources/perch-hook.sh"
            return Paths(home: home, launcherTarget: target)
        }
    }

    // MARK: Status

    /// Reads only. Nothing on disk changes until someone presses Connect.
    static func status(_ paths: Paths, appPath: String) -> Status {
        do {
            let plan = try Plan(paths)
            guard plan.hasWork else { return .ready }
            return appPath == installedApp ? .needsConnect : .notInApplications
        } catch {
            return .failed("\(error)")
        }
    }

    @discardableResult
    static func connect(_ paths: Paths, now: Date = Date()) throws -> Report {
        let plan = try Plan(paths)
        let fm = FileManager.default
        // Before the hooks name the launcher, never after.
        if plan.launcherStale {
            try fm.createDirectory(atPath: (paths.launcher as NSString).deletingLastPathComponent,
                                   withIntermediateDirectories: true)
            let tmp = paths.launcher + ".perch-tmp-\(getpid())"
            try? fm.removeItem(atPath: tmp)
            try fm.createSymbolicLink(atPath: tmp, withDestinationPath: paths.launcherTarget)
            try replace(paths.launcher, with: tmp)
        }
        if let text = plan.claude {
            try backup(paths.claudeSettings, now: now)
            try writeAtomic(paths.claudeSettings, text)
        }
        if let text = plan.codex {
            try backup(paths.codexHooks, now: now)
            try writeAtomic(paths.codexHooks, text)
        }
        return Report(codexNeedsTrust: plan.codexNeedsTrust)
    }

    /// What connecting would change, worked out in full before anything is written.
    private struct Plan {
        var launcherStale = false
        /// The new file contents, or nil when that agent is absent or already wired.
        var claude: String?
        var codex: String?
        var codexNeedsTrust = false

        var hasWork: Bool { claude != nil || codex != nil || launcherStale }

        init(_ paths: Paths) throws {
            let claudeHere = isDirectory(paths.claudeDir)
            let codexHere = isDirectory(paths.codexDir)
            guard claudeHere || codexHere else { return }

            if claudeHere {
                let root = try read(paths.claudeSettings)
                if !claudeWired(root, paths) {
                    claude = try wireClaude(root, paths).pythonDump(asciiOnly: true, sortKeys: false) + "\n"
                }
            }
            if codexHere {
                let root = try read(paths.codexHooks)
                if !codexWired(root, paths) {
                    let (wired, retrust) = try wireCodex(root, paths)
                    codex = wired.pythonDump(asciiOnly: false, sortKeys: true) + "\n"
                    codexNeedsTrust = retrust
                }
            }
            launcherStale = !launcherCurrent(paths)
            // A link to a script that cannot run is the same silent failure the link exists to
            // avoid, so a broken copy of the app says so here.
            if launcherStale, !FileManager.default.isExecutableFile(atPath: paths.launcherTarget) {
                throw SetupError(description: "the app's hook script is missing or not executable: \(paths.launcherTarget)")
            }
        }
    }

    // MARK: Claude Code

    /// `remove_perch_hooks` then `add_hook` for each event, as `install-island-hooks.py` runs
    /// them. Ours always end up last in each event: Claude Code keeps no trust by position.
    static func wireClaude(_ file: OrderedJSON?, _ paths: Paths) throws -> OrderedJSON {
        var settings = file ?? .object([])
        guard case .object = settings else { throw SetupError(description: "settings.json is not a JSON object") }
        for (event, word) in events {
            if let hooksRoot = settings["hooks"] {
                guard case .object = hooksRoot else { throw shape("hooks") }
                if let listed = hooksRoot[event] {
                    guard case .array(let entries) = listed else { throw shape("hooks.\(event)") }
                    if !entries.isEmpty {
                        var kept: [OrderedJSON] = []
                        for var entry in entries {
                            guard case .object = entry else { throw shape("hooks.\(event)[]") }
                            let hooks = try iterable(entry["hooks"], "hooks.\(event)[].hooks")
                            var keptHooks: [OrderedJSON] = []
                            for hook in hooks where !isPerchCommand(try command(of: hook), codex: false) {
                                keptHooks.append(hook)
                            }
                            // An entry that held only our hooks goes; one that was already empty stays.
                            if !keptHooks.isEmpty || hooks.isEmpty {
                                entry.set("hooks", .array(keptHooks))
                                kept.append(entry)
                            }
                        }
                        var updated = hooksRoot
                        updated.set(event, .array(kept))
                        settings.set("hooks", updated)
                    }
                }
            }
            var hooksRoot = settings["hooks"] ?? .object([])
            guard case .object = hooksRoot else { throw shape("hooks") }
            guard case .array(var entries) = hooksRoot[event] ?? .array([]) else { throw shape("hooks.\(event)") }
            entries.append(.object([
                .init(key: "matcher", value: .string("*")),
                .init(key: "hooks", value: .array([.object([
                    .init(key: "type", value: .string("command")),
                    .init(key: "command", value: .string(paths.command(word, "claude"))),
                ])])),
            ]))
            hooksRoot.set(event, .array(entries))
            settings.set("hooks", hooksRoot)
        }
        return settings
    }

    /// Each event holds exactly one hook of ours, and it is the current command.
    private static func claudeWired(_ file: OrderedJSON?, _ paths: Paths) -> Bool {
        guard let hooksRoot = file?["hooks"] else { return false }
        return events.allSatisfy { event, word in
            guard case .array(let entries)? = hooksRoot[event] else { return false }
            let ours = entries.flatMap { entry -> [String] in
                guard case .array(let hooks)? = entry["hooks"] else { return [] }
                return hooks.compactMap { hook in
                    guard case .string(let c)? = hook["command"], isPerchCommand(c, codex: false) else { return nil }
                    return c
                }
            }
            return ours == [paths.command(word, "claude")]
        }
    }

    // MARK: codex

    private static func codexHook(_ paths: Paths, _ word: String) -> OrderedJSON {
        .object([
            .init(key: "command", value: .string(paths.command(word, "codex"))),
            .init(key: "timeout", value: .integer("5")),
            .init(key: "type", value: .string("command")),
        ])
    }

    /// `upsert` for each event, then the same self-check before writing: every hook that is
    /// not ours must keep its address and its bytes, because codex keys trust by
    /// `<event>:<group>:<hook>` and a hook that moves is silently refused.
    static func wireCodex(_ file: OrderedJSON?, _ paths: Paths) throws -> (OrderedJSON, Bool) {
        var root = file ?? .object([])
        guard case .object = root else { throw SetupError(description: "hooks.json is not a JSON object") }
        let foreignBefore = try foreignHooks(root)
        let stateBefore = root["state"]
        var retrust = false

        for (event, word) in events {
            var hooksRoot = root["hooks"] ?? .object([])
            guard case .object = hooksRoot else { throw shape("hooks") }
            guard case .array(var groups) = hooksRoot[event] ?? .array([]) else { throw shape("hooks.\(event)") }
            let hook = codexHook(paths, word)

            // Only a trailing group that is entirely ours is swept: removing anything earlier
            // would shift every later hook's address.
            while let last = groups.last, try isPurelyPerch(last), try perchAddresses(groups).count > 1 {
                groups.removeLast()
            }
            if let (i, j) = try perchAddresses(groups).first {
                guard case .array(var hooks)? = groups[i]["hooks"] else { throw shape("hooks.\(event)[].hooks") }
                if !OrderedJSON.pyEqual(hooks[j], hook) { retrust = true }
                hooks[j] = hook
                groups[i].set("hooks", .array(hooks))
            } else {
                groups.append(.object([.init(key: "hooks", value: .array([hook]))]))
                retrust = true
            }
            hooksRoot.set(event, .array(groups))
            root.set("hooks", hooksRoot)
        }

        let foreignAfter = try foreignHooks(root)
        let undisturbed = foreignBefore.count == foreignAfter.count && foreignBefore.allSatisfy { address, hook in
            foreignAfter.first { $0.0 == address }.map { OrderedJSON.pyEqual($0.1, hook) } ?? false
        }
        guard undisturbed else {
            throw SetupError(description: "connecting would disturb hooks that are not Perch's; nothing was written")
        }
        let stateKept: Bool
        switch (stateBefore, root["state"]) {
        case (nil, nil): stateKept = true
        case let (a?, b?): stateKept = OrderedJSON.pyEqual(a, b)
        default: stateKept = false
        }
        guard stateKept else { throw SetupError(description: "connecting would touch codex's state section; nothing was written") }
        return (root, retrust)
    }

    private static func codexWired(_ file: OrderedJSON?, _ paths: Paths) -> Bool {
        guard let hooksRoot = file?["hooks"] else { return false }
        return events.allSatisfy { event, word in
            guard case .array(let groups)? = hooksRoot[event],
                  let addresses = try? perchAddresses(groups), addresses.count == 1,
                  case .array(let hooks)? = groups[addresses[0].0]["hooks"] else { return false }
            return OrderedJSON.pyEqual(hooks[addresses[0].1], codexHook(paths, word))
        }
    }

    private static func perchAddresses(_ groups: [OrderedJSON]) throws -> [(Int, Int)] {
        var found: [(Int, Int)] = []
        for (i, group) in groups.enumerated() {
            guard case .object = group else { throw shape("a codex hook group") }
            for (j, hook) in try iterable(group["hooks"], "a codex hook group's hooks").enumerated()
            where isPerchCommand(try command(of: hook), codex: true) {
                found.append((i, j))
            }
        }
        return found
    }

    private static func isPurelyPerch(_ group: OrderedJSON) throws -> Bool {
        let hooks = try iterable(group["hooks"], "a codex hook group's hooks")
        return try !hooks.isEmpty && hooks.allSatisfy { isPerchCommand(try command(of: $0), codex: true) }
    }

    /// Every hook that is not ours, by `(event, group, hook)`, across every event in the file.
    private static func foreignHooks(_ root: OrderedJSON) throws -> [((String, Int, Int), OrderedJSON)] {
        guard let hooksRoot = root["hooks"] else { return [] }
        guard case .object(let events) = hooksRoot else { throw shape("hooks") }
        var found: [((String, Int, Int), OrderedJSON)] = []
        for member in events {
            for (i, group) in try iterable(member.value, "hooks.\(member.key)").enumerated() {
                guard case .object = group else { throw shape("hooks.\(member.key)[]") }
                for (j, hook) in try iterable(group["hooks"], "hooks.\(member.key)[].hooks").enumerated()
                where !isPerchCommand(try command(of: hook), codex: true) {
                    found.append(((member.key, i, j), hook))
                }
            }
        }
        return found
    }

    // MARK: Recognising our own hooks

    // The same patterns as the Python installers, which explain them. The codex side also
    // owns the two `lastrun` files its older commands wrote.
    private static let launcherPattern = try! NSRegularExpression(pattern: #"\.perch/bin/perch-hook"#)
    private static let claudeArtifacts = try! NSRegularExpression(
        pattern: #"Group Containers/[^"'\s]*/(?:bridge\.sock|agent-event\.txt)"#)
    private static let codexArtifacts = try! NSRegularExpression(
        pattern: #"Group Containers/[^"'\s]*/(?:bridge\.sock|agent-event\.txt|codex-hook\.lastrun|codex-notify\.lastrun)"#)
    private static let wirePattern = try! NSRegularExpression(pattern: #"-\$\$(?:\\t|\t)(?:claude|codex)"#)

    static func isPerchCommand(_ command: String, codex: Bool) -> Bool {
        func found(_ pattern: NSRegularExpression) -> Bool {
            pattern.firstMatch(in: command, range: NSRange(command.startIndex..., in: command)) != nil
        }
        if found(launcherPattern) { return true }
        return found(codex ? codexArtifacts : claudeArtifacts) && found(wirePattern)
    }

    // MARK: Files

    /// The launcher is current when it is our link, or a copy byte-identical to the script
    /// this app ships (what the Python installer leaves behind).
    private static func launcherCurrent(_ paths: Paths) -> Bool {
        let fm = FileManager.default
        if let target = try? fm.destinationOfSymbolicLink(atPath: paths.launcher) {
            return target == paths.launcherTarget
        }
        guard let installed = fm.contents(atPath: paths.launcher),
              let shipped = fm.contents(atPath: paths.launcherTarget) else { return false }
        return installed == shipped && fm.isExecutableFile(atPath: paths.launcher)
    }

    private static func read(_ path: String) throws -> OrderedJSON? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        guard let data = FileManager.default.contents(atPath: path) else {
            throw SetupError(description: "cannot read \(path)")
        }
        do {
            return try OrderedJSON.parse(data)
        } catch {
            throw SetupError(description: "cannot read \(path): \(error)")
        }
    }

    private static func isDirectory(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
    }

    /// A copy beside the file, never overwriting an earlier one: it may be the only copy of
    /// the config from before Perch touched it.
    private static func backup(_ path: String, now: Date) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: path) else { return }
        let stem = "\(path).perch-backup-\(Int(now.timeIntervalSince1970))"
        var dest = stem
        var n = 1
        while fm.fileExists(atPath: dest) {
            dest = "\(stem)-\(n)"
            n += 1
        }
        try fm.copyItem(atPath: path, toPath: dest)
    }

    /// Through a temporary file in the same folder, then a rename, so a full disk or a power
    /// cut leaves either the old file or the new one and never half of one. The old file's
    /// permissions carry over.
    private static func writeAtomic(_ path: String, _ text: String) throws {
        let tmp = "\(path).perch-tmp-\(getpid())"
        let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw SetupError(description: "cannot write \(tmp): \(String(cString: strerror(errno)))") }
        let bytes = Array(text.utf8)
        let written = bytes.withUnsafeBufferPointer { Foundation.write(fd, $0.baseAddress, $0.count) }
        let synced = fsync(fd) == 0
        close(fd)
        guard written == bytes.count, synced else {
            unlink(tmp)
            throw SetupError(description: "cannot write \(tmp)")
        }
        if let mode = (try? FileManager.default.attributesOfItem(atPath: path))?[.posixPermissions] as? NSNumber {
            chmod(tmp, mode_t(mode.uint16Value))
        }
        try replace(path, with: tmp)
    }

    private static func replace(_ path: String, with tmp: String) throws {
        guard rename(tmp, path) == 0 else {
            let reason = String(cString: strerror(errno))
            unlink(tmp)
            throw SetupError(description: "cannot replace \(path): \(reason)")
        }
    }

    // MARK: Shapes

    /// The command of one hook object, or "" when it has none.
    private static func command(of hook: OrderedJSON) throws -> String {
        guard case .object = hook else { throw shape("a hook") }
        switch hook["command"] {
        case nil: return ""
        case .string(let text)?: return text
        default: throw shape("a hook's command")
        }
    }

    /// What iterating a value yields in Python, for the shapes a hook list can take. An empty
    /// object or string iterates as nothing; anything else that is not a list would fail
    /// there too.
    private static func iterable(_ value: OrderedJSON?, _ what: String) throws -> [OrderedJSON] {
        switch value {
        case nil: return []
        case .array(let items)?: return items
        case .object(let members)? where members.isEmpty: return []
        case .string(let text)? where text.isEmpty: return []
        default: throw shape(what)
        }
    }

    private static func shape(_ what: String) -> SetupError {
        SetupError(description: "unexpected shape at \(what)")
    }
}
