import AppKit

/// The menu a right-click on the open card brings up: the version, Record, Open at Login,
/// Disconnect Agents and Quit. Perch has no Dock icon and no menu bar, so without it there
/// would be no way to quit, and nowhere to read which version is running.
///
/// Built afresh on every right-click, so each line reads the state of that moment. The
/// branch under the bird keeps its own right-click (undoing a correction); it claims the
/// click before this menu would see it.
@MainActor
final class IslandMenu: NSObject {
    private let viewModel: IslandViewModel

    init(viewModel: IslandViewModel) {
        self.viewModel = viewModel
    }

    func make() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let title = NSMenuItem(title: "Perch \(version)", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())

        let record = NSMenuItem(title: "Record", action: #selector(openRecord), keyEquivalent: "")
        record.target = self
        record.state = viewModel.showingRecord ? .on : .off
        menu.addItem(record)

        // The card offers the wait after a move that answered a reminder. With reminders off
        // none comes, so this is the way back.
        let reminders = NSMenuItem(title: "Stretch Reminders", action: nil, keyEquivalent: "")
        let waits = NSMenu()
        waits.autoenablesItems = false
        for minutes in StretchInterval.choices {
            let item = NSMenuItem(title: StretchInterval.label(minutes), action: #selector(chooseWait),
                                  keyEquivalent: "")
            item.target = self
            item.representedObject = minutes
            item.state = minutes == viewModel.stretchMinutes ? .on : .off
            if minutes == nil { waits.addItem(.separator()) }
            waits.addItem(item)
        }
        reminders.submenu = waits
        menu.addItem(reminders)

        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        switch LoginItem.state {
        case .on:
            login.state = .on
        case .off:
            login.state = .off
        case .installer:
            // The source installer's own job starts Perch; turning it off is the installer's business.
            login.state = .on
            login.isEnabled = false
            login.toolTip = "Set up by install-island-app.py"
        }
        menu.addItem(login)

        if HookSetup.hasPerchHooks(.forThisMac()) {
            let disconnect = NSMenuItem(title: "Disconnect Agents…", action: #selector(confirmDisconnect),
                                        keyEquivalent: "")
            disconnect.target = self
            menu.addItem(disconnect)
        }
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Perch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        quit.target = NSApp
        menu.addItem(quit)
        return menu
    }

    @objc private func chooseWait(_ sender: NSMenuItem) {
        viewModel.chooseStretchInterval(sender.representedObject as? Int)
    }

    @objc private func openRecord() {
        viewModel.toggleRecord()
    }

    @objc private func toggleLogin(_ sender: NSMenuItem) {
        do {
            try LoginItem.set(sender.state != .on)
        } catch {
            show("Couldn't change Open at Login", "\(error)")
        }
    }

    @objc private func confirmDisconnect() {
        let alert = NSAlert()
        alert.messageText = "Disconnect Claude Code and codex from Perch?"
        alert.informativeText = "Perch removes only its own hooks and keeps a backup beside each file. "
            + "Connect on the card puts them back."
        alert.addButton(withTitle: "Disconnect")
        alert.addButton(withTitle: "Cancel")
        guard ask(alert) == .alertFirstButtonReturn else { return }
        do {
            try viewModel.disconnectAgents()
        } catch {
            show("Couldn't disconnect", "\(error)")
        }
    }

    private func show(_ message: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        _ = ask(alert)
    }

    /// An app with no Dock icon is never the active app, so an alert would open behind
    /// whatever window is in front. Activating first brings it forward.
    private func ask(_ alert: NSAlert) -> NSApplication.ModalResponse {
        NSApp.activate()
        return alert.runModal()
    }
}
