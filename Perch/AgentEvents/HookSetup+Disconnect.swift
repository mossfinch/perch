import Foundation

/// Undoing Connect from inside the app, so someone who downloaded Perch can take it out of
/// their agents without editing JSON by hand.
///
/// The Python installers have no counterpart, so there is no byte-for-byte reference here.
/// The rules are Connect's: everything is read and planned before anything is written, a
/// timestamped backup goes beside each file, only Perch's own hooks are removed, and the
/// write is an atomic rename.
///
/// The launcher in `~/.perch/bin` stays. With no hook naming it, it never runs, and a
/// source install's codex notify script may still call it.
extension HookSetup {
    struct DisconnectReport: Equatable {
        var claude: Bool
        var codex: Bool
        var nothingToDo: Bool { !claude && !codex }
    }

    /// Whether there is anything to disconnect. An unreadable file counts as yes, so the menu
    /// offers the item and pressing it says what is wrong.
    static func hasPerchHooks(_ paths: Paths) -> Bool {
        do {
            if let root = try read(paths.claudeSettings), try unwireClaude(root) != nil { return true }
            if let root = try read(paths.codexHooks), try unwireCodex(root) != nil { return true }
            return false
        } catch {
            return true
        }
    }

    @discardableResult
    static func disconnect(_ paths: Paths, now: Date = Date()) throws -> DisconnectReport {
        var claudeText: String?
        var codexText: String?
        if let root = try read(paths.claudeSettings), let unwired = try unwireClaude(root) {
            claudeText = unwired.pythonDump(asciiOnly: true, sortKeys: false) + "\n"
        }
        if let root = try read(paths.codexHooks), let unwired = try unwireCodex(root) {
            codexText = unwired.pythonDump(asciiOnly: false, sortKeys: true) + "\n"
        }
        if let text = claudeText {
            try backup(paths.claudeSettings, now: now)
            try writeAtomic(paths.claudeSettings, text)
        }
        if let text = codexText {
            try backup(paths.codexHooks, now: now)
            try writeAtomic(paths.codexHooks, text)
        }
        return DisconnectReport(claude: claudeText != nil, codex: codexText != nil)
    }

    /// `settings.json` without Perch's hooks, or nil when it holds none. Claude Code keeps no
    /// trust by position, so removing from the middle of a list is safe. An entry left with
    /// no hooks goes, and so does an event left with no entries; one that was already empty
    /// before stays as it was.
    static func unwireClaude(_ file: OrderedJSON) throws -> OrderedJSON? {
        guard case .object = file else { throw SetupError(description: "settings.json is not a JSON object") }
        guard let hooksRoot = file["hooks"] else { return nil }
        guard case .object(let events) = hooksRoot else { throw shape("hooks") }
        var removed = false
        var keptEvents: [OrderedJSON.Member] = []
        for member in events {
            guard case .array(let entries) = member.value, !entries.isEmpty else {
                keptEvents.append(member)
                continue
            }
            var keptEntries: [OrderedJSON] = []
            for var entry in entries {
                guard case .object = entry else { throw shape("hooks.\(member.key)[]") }
                let hooks = try iterable(entry["hooks"], "hooks.\(member.key)[].hooks")
                let keptHooks = try hooks.filter { !isPerchCommand(try command(of: $0), codex: false) }
                if keptHooks.count == hooks.count {
                    keptEntries.append(entry)
                    continue
                }
                removed = true
                if !keptHooks.isEmpty {
                    entry.set("hooks", .array(keptHooks))
                    keptEntries.append(entry)
                }
            }
            if !keptEntries.isEmpty {
                keptEvents.append(.init(key: member.key, value: .array(keptEntries)))
            }
        }
        guard removed else { return nil }
        var settings = file
        settings.set("hooks", .object(keptEvents))
        return settings
    }

    /// `hooks.json` without Perch's hooks, or nil when it holds none.
    ///
    /// codex keys trust by `<event>:<group>:<hook>`, so a hook that moves is silently refused.
    /// Only hooks with nothing after them can go: a trailing group that is all ours, or ours
    /// at the end of the last group. One of ours sitting before another tool's hook would
    /// shift it, so that refuses the whole disconnect and writes nothing.
    static func unwireCodex(_ file: OrderedJSON) throws -> OrderedJSON? {
        guard case .object = file else { throw SetupError(description: "hooks.json is not a JSON object") }
        guard let hooksRoot = file["hooks"] else { return nil }
        guard case .object(let events) = hooksRoot else { throw shape("hooks") }
        let foreignBefore = try foreignHooks(file)
        var removed = false
        var keptEvents: [OrderedJSON.Member] = []
        for member in events {
            var groups = try iterable(member.value, "hooks.\(member.key)")
            let hadGroups = !groups.isEmpty
            while let last = groups.last {
                if try isPurelyPerch(last) {
                    groups.removeLast()
                    removed = true
                    continue
                }
                var hooks = try iterable(last["hooks"], "hooks.\(member.key)[].hooks")
                guard let tail = hooks.last, isPerchCommand(try command(of: tail), codex: true) else { break }
                hooks.removeLast()
                groups[groups.count - 1].set("hooks", .array(hooks))
                removed = true
            }
            guard try perchAddresses(groups).isEmpty else {
                throw SetupError(description:
                    "Perch's \(member.key) hook in codex sits before another hook; remove it in codex's /hooks panel. Nothing was written")
            }
            if groups.isEmpty && hadGroups { continue }
            keptEvents.append(groups.isEmpty ? member : .init(key: member.key, value: .array(groups)))
        }
        guard removed else { return nil }
        var root = file
        root.set("hooks", .object(keptEvents))
        // The same self-check Connect runs: every other hook keeps its address and its bytes.
        let foreignAfter = try foreignHooks(root)
        let undisturbed = foreignBefore.count == foreignAfter.count && foreignBefore.allSatisfy { address, hook in
            foreignAfter.first { $0.0 == address }.map { OrderedJSON.pyEqual($0.1, hook) } ?? false
        }
        guard undisturbed else {
            throw SetupError(description: "disconnecting would disturb hooks that are not Perch's; nothing was written")
        }
        return root
    }
}
