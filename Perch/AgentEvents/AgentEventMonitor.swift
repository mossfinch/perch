import Foundation
import Darwin

/// Listens for agent lifecycle events over a Unix domain socket in the App Group
/// container, pushing them to the island the instant a hook connects.
///
/// Why a socket instead of polling a file: each hook fires one tiny message per
/// event; a stream socket delivers it immediately, with no timer wakeups and no
/// file re-arm races. The socket lives inside the App Group container so the
/// sandboxed island may bind it — AF_UNIX access is mediated by file-system
/// permission on the socket path, not by the network entitlements — while the
/// unsandboxed shell hook connects to that same absolute path via `nc -U`.
///
/// Fail-open: if the island is not running nothing binds the socket, the hook's
/// `nc -U` simply fails to connect, and Claude Code proceeds unaffected.
///
/// `@unchecked Sendable`: the mutable state (`listenFD` / `acceptSource`) is
/// touched only on the serial `queue` below, and the three callbacks are set
/// once before `start()` and read-only afterwards. Safety rests on those two
/// conventions, not on the type system — the same kind of honest declaration
/// as the `nonisolated(unsafe)` in `AgentEventLog`.
final class AgentEventMonitor: @unchecked Sendable {
    /// App Group: see `AppGroup.swift` (read from Info.plist; no Team ID in source).
    static var appGroupID: String { AppGroup.id }

    static let socketFileName = "bridge.sock"

    static var socketURL: URL {
        AppGroup.containerURL.appendingPathComponent(socketFileName)
    }

    // Callback parameters = (project directory cwd, source agent).
    // Source is the 4th field, added later: older hooks push three fields, and
    // three-field messages count as claude — so sessions still running with an
    // old hook (hooks are read once at session start) survive an upgrade intact.
    var onWorking: (@MainActor (String, String) -> Void)?
    var onWaiting: (@MainActor (String, String) -> Void)?
    var onComplete: (@MainActor (String, String) -> Void)?

    private let queue = DispatchQueue(label: "io.github.mossfinch.perch.agent-socket")
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?

    func start() {
        queue.async { [weak self] in self?.bindAndListen() }
    }

    func stop() {
        queue.async { [weak self] in self?.teardown() }
    }

    // MARK: - socket lifecycle (all on `queue`)

    private func bindAndListen() {
        guard listenFD < 0 else { return }   // already listening; idempotent

        let url = Self.socketURL
        let path = url.path
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        unlink(path)   // remove last run's leftover socket file, or bind hits EADDRINUSE

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)   // 104
        guard path.utf8.count < capacity else { close(fd); return }   // overlong path: better not to start than to bind a truncated mess
        withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                _ = path.withCString { strncpy(dst, $0, capacity - 1) }
            }
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0 else { close(fd); return }
        guard listen(fd, 4) == 0 else { close(fd); unlink(path); return }

        listenFD = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptOne() }
        source.setCancelHandler { close(fd); unlink(path) }   // the one place that closes the fd and removes the file
        acceptSource = source
        source.resume()
    }

    private func acceptOne() {
        let client = accept(listenFD, nil, nil)
        guard client >= 0 else { return }
        defer { close(client) }

        var tv = timeval(tv_sec: 1, tv_usec: 0)   // 1s receive timeout so a mute connection can't stall the accept loop
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        // Read in a loop rather than once: a single read can come back with
        // only part of the line, and a truncated line loses its trailing
        // field — the event would be filed under a garbage source.
        //
        // The line carries four tab-separated fields and no terminator, so
        // "four fields in hand and nothing more waiting" is as complete as it
        // gets; waiting for the peer to close would idle a whole receive
        // timeout on every event. The byte cap keeps a wedged peer from
        // growing this without bound.
        var message = [UInt8]()
        var chunk = [UInt8](repeating: 0, count: 512)
        while message.count < 4096 {
            let n = read(client, &chunk, chunk.count)
            if n <= 0 { break }   // peer closed, or the receive timeout hit
            message.append(contentsOf: chunk[0..<n])
            let tabs = message.filter { $0 == UInt8(ascii: "\t") }.count
            if n < chunk.count, tabs >= 3 { break }
        }
        guard !message.isEmpty, let text = String(bytes: message, encoding: .utf8) else { return }
        deliver(text)
    }

    private func deliver(_ text: String) {
        // Format: <event>\t<projectDir>\t<nonce>\t<source>
        // source is the later-added 4th field; when absent it counts as claude
        // (see the callback comment above).
        let parts = text.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        func field(_ i: Int) -> String {
            parts.count > i ? parts[i].trimmingCharacters(in: .whitespacesAndNewlines) : ""
        }
        let event = field(0)
        let project = field(1)
        let rawSource = field(3).lowercased()
        let source = rawSource.isEmpty ? "claude" : rawSource
        switch event {
        case "working":
            let cb = onWorking
            Task { @MainActor in cb?(project, source) }   // hop to the main thread without capturing non-Sendable self
        case "waiting":
            let cb = onWaiting
            Task { @MainActor in cb?(project, source) }
        case "complete":
            let cb = onComplete
            Task { @MainActor in cb?(project, source) }
        default:
            break
        }
    }

    private func teardown() {
        acceptSource?.cancel()   // the cancel handler closes the fd and unlinks the socket file
        acceptSource = nil
        listenFD = -1
    }
}
