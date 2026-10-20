import Foundation

/// Brings forward the Terminal tab an agent runs in, found by the tab's tty.
///
/// The script is fixed text. The tty goes in as the one argument to its one handler, passed as
/// an Apple event parameter, so nothing that arrives on the socket is ever part of a script, and
/// all the script can do is look through Terminal's tabs, select the one with that tty and raise
/// its window, bringing it back from the Dock if it was minimized. The window is raised last:
/// bringing Terminal forward puts the window that was current in Terminal back on top, and a
/// window coming back from the Dock is still on its way when the script moves on, so it waits. macOS lets Perch send these events to Terminal and to no other app, and asks the
/// user once before the first one goes through.
///
/// A tab whose program has finished stays open still naming the tty it had, and macOS hands that
/// tty to the next tab opened, so only a tab with something still running in it counts.
///
/// `reveal` answers false when the tab is gone, when the user has not allowed it, or when Terminal
/// does not answer in time; the caller then brings Terminal forward as before.
enum TerminalTab {
    private static let queue = DispatchQueue(label: "io.github.mossfinch.perch.terminal-tab")

    private static let source = """
    on reveal(wanted)
        with timeout of 10 seconds
            tell application id "com.apple.Terminal"
                repeat with w in windows
                    repeat with t in tabs of w
                        if tty of t is wanted and processes of t is not {} then
                            if miniaturized of w then
                                set miniaturized of w to false
                                delay 0.5
                            end if
                            set selected tab of w to t
                            activate
                            set index of w to 1
                            return true
                        end if
                    end repeat
                end repeat
            end tell
        end timeout
        return false
    end reveal
    """

    /// Off the main thread: the first time, macOS holds the event until the user answers.
    static func reveal(tty: String, then completion: @escaping @MainActor @Sendable (Bool) -> Void) {
        queue.async {
            let found = run(tty)
            Task { @MainActor in completion(found) }
        }
    }

    private static func run(_ tty: String) -> Bool {
        guard let script = NSAppleScript(source: source) else { return false }
        let call = NSAppleEventDescriptor(eventClass: code("ascr"), eventID: code("psbr"),
                                          targetDescriptor: .currentProcess(),
                                          returnID: AEReturnID(kAutoGenerateReturnID),
                                          transactionID: AETransactionID(kAnyTransactionID))
        call.setDescriptor(NSAppleEventDescriptor(string: "reveal"), forKeyword: code("snam"))
        let arguments = NSAppleEventDescriptor.list()
        arguments.insert(NSAppleEventDescriptor(string: tty), at: 1)
        call.setDescriptor(arguments, forKeyword: code("----"))
        var error: NSDictionary?
        let result = script.executeAppleEvent(call, error: &error)
        return error == nil && result.booleanValue
    }

    /// An Apple event code from its four characters: `ascr` is AppleScript's suite, `psbr` a call
    /// to a handler by name, `snam` that name, `----` the direct parameter.
    private static func code(_ chars: String) -> FourCharCode {
        chars.utf8.reduce(0) { $0 << 8 | FourCharCode($1) }
    }
}
