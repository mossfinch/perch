import Foundation
import ServiceManagement

/// Opening Perch at login, for a download.
///
/// It is the ordinary login item (`SMAppService.mainApp`): at login macOS opens the app as
/// if someone had double-clicked it. A launchd job shipped inside the app could also bring
/// Perch back after macOS kills it, but macOS pins such a job to the exact binary it first
/// saw, and an ad-hoc signed app is a different binary after every update: the job would be
/// refused at the next launch, silently. So a download starts at login and nothing more.
///
/// A source install already starts at login, and comes back after a kill, through the job
/// `install-island-app.py` writes to `~/Library/LaunchAgents`. A login item on top would
/// start two copies at every login, and two copies starting together can each see the
/// other and both step aside, leaving none. So on a source install the switch only reports
/// the installer's job and leaves it alone.
enum LoginItem {
    static let installerLabel = "io.github.mossfinch.perch"
    private static let defaultedKey = "loginItemDefaulted"

    enum State: Equatable {
        case on
        case off
        /// A source install, whose own launchd job this switch does not own.
        case installer
    }

    private static var service: SMAppService { .mainApp }

    /// Either sign is enough: launchd names the job that started a process in
    /// `XPC_SERVICE_NAME`, and the source installer leaves the history rebuild in
    /// `~/.perch/bin`, which a download never has. The second covers Perch opened by hand.
    static var installedFromSource: Bool {
        ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] == installerLabel
            || FileManager.default.fileExists(atPath: HookSetup.Paths.forThisMac().home + "/.perch/bin/perch-reconcile")
    }

    static var state: State {
        if installedFromSource { return .installer }
        switch service.status {
        case .enabled, .requiresApproval: return .on
        default: return .off
        }
    }

    static func set(_ on: Bool) throws {
        guard !installedFromSource else { return }
        if on { try service.register() } else { try service.unregister() }
    }

    /// On by default, once: the first launch from Applications turns it on. Turned off by
    /// hand, it stays off. Outside Applications the item would point at an app that is about
    /// to move, and a recording in demo mode is not a real install.
    static func defaultOnFirstLaunch() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: defaultedKey), !installedFromSource, !DataHome.isDemo,
              Bundle.main.bundlePath == HookSetup.installedApp else { return }
        defaults.set(true, forKey: defaultedKey)
        do {
            try set(true)
        } catch {
            // The menu shows the switch off, which is the truth; the reason goes to the log.
            FileHandle.standardError.write(Data("Perch: could not turn on Open at Login: \(error)\n".utf8))
        }
    }
}
