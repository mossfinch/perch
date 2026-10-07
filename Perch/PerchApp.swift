import SwiftUI

@main
struct PerchApp: App {
    @NSApplicationDelegateAdaptor(PerchAppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings { EmptyView() }
    }
}

@MainActor
final class PerchAppDelegate: NSObject, NSApplicationDelegate {
    private var islandWindowController: IslandWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One instance only. Two panels would sit exactly on top of each other
        // at the one notch, and only the instance holding the socket gets agent
        // events, so the other would keep drawing while receiving nothing.
        // The newcomer exits. This runs before IslandWindowController is made,
        // or the newcomer would take the socket from the running instance first.
        guard !Self.anotherInstanceIsRunning else {
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.accessory)
        let controller = IslandWindowController()
        islandWindowController = controller
        controller.activate()
    }

    private static var anotherInstanceIsRunning: Bool {
        let me = NSRunningApplication.current
        guard let bundleID = me.bundleIdentifier else { return false }
        return NSWorkspace.shared.runningApplications.contains {
            $0.bundleIdentifier == bundleID && $0.processIdentifier != me.processIdentifier
        }
    }
}
