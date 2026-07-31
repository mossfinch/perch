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
        // Single instance: there is only one notch, so two panels would stack
        // exactly on top of each other, indistinguishable by eye — and agent
        // events reach only whichever instance grabbed the socket; the other
        // is a zombie pulsing in place, receiving nothing. The newcomer exits.
        // Must run before IslandWindowController, or the newcomer would first
        // steal the socket from the earlier instance.
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
