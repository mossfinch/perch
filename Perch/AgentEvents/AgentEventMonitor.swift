import Foundation
import Darwin

/// Receives agent lifecycle events on a Unix domain socket in `~/.perch/island`
/// and hands them to the island as soon as a hook connects.
///
/// A socket rather than a polled file: each hook sends one small message per
/// event, and a stream socket delivers it at once, with no timer wakeups and no
/// file re-arm races. The sandbox refuses a socket bind outside the app's own
/// container unless a rule allows it; `Perch.entitlements` carries one rule
/// that allows it in `~/.perch/island` and nowhere else, and grants no network
/// access. The unsandboxed shell hook connects to the same absolute path with
/// `nc -U`.
///
/// Fail-open: when the island is not running nothing binds the socket, the
/// hook's `nc -U` fails to connect, and the agent carries on unaffected.
///
/// `@unchecked Sendable`: the mutable state (`listenFD`, `acceptSource`) is
/// touched only on the serial `queue`, and the callbacks are set once before
/// `start()` and only read afterwards. Safety rests on those two conventions,
/// not on the type system, like the `nonisolated(unsafe)` in `AgentEventLog`.
final class AgentEventMonitor: @unchecked Sendable {
    static let socketFileName = "bridge.sock"

    static var socketURL: URL {
        DataHome.url.appendingPathComponent(socketFileName)
    }

    // Callback parameters: (project directory, source agent, host app).
    // A message with only three fields counts as claude. Hooks are read once
    // when a session starts, so a session still running an older hook that
    // sends three fields keeps working across an upgrade. The host is the app
    // the agent runs in, and its session when that app is the Claude app; nil
    // when the hook did not say.
    var onWorking: (@MainActor (String, String, AgentHost?) -> Void)?
    var onWaiting: (@MainActor (String, String, AgentHost?) -> Void)?
    var onComplete: (@MainActor (String, String, AgentHost?) -> Void)?
    var onReconciliation: ((Data, Data) -> Void)?
    /// The socket could not be set up, with the reason. Without it no hook can
    /// reach the island, and an island that looks fine while hearing nothing is
    /// the failure this exists to prevent: the card says so instead.
    var onListenFailed: (@MainActor (String) -> Void)?

    private static let maxReconciliationBytes = 4 * 1024 * 1024
    private static let maxHookLedgerBytes = 8 * 1024 * 1024

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

        if let problem = DataHome.privacyProblem { return reportFailure(problem, nil) }
        let url = Self.socketURL
        let path = url.path
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        unlink(path)   // remove last run's leftover socket file, or bind hits EADDRINUSE

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return reportFailure("socket", errno) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)   // 104
        guard path.utf8.count < capacity else {   // overlong path: better not to start than to bind a truncated mess
            close(fd)
            return reportFailure("path too long", nil)
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                _ = path.withCString { strncpy(dst, $0, capacity - 1) }
            }
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0 else {
            let code = errno
            close(fd)
            return reportFailure("bind", code)
        }
        guard listen(fd, 4) == 0 else {
            let code = errno
            close(fd); unlink(path)
            return reportFailure("listen", code)
        }

        listenFD = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptOne() }
        source.setCancelHandler { close(fd); unlink(path) }   // the one place that closes the fd and removes the file
        acceptSource = source
        source.resume()
    }

    private func reportFailure(_ step: String, _ code: Int32?) {
        let reason = code.map { "\(step): \(String(cString: strerror($0)))" } ?? step
        let callback = onListenFailed
        Task { @MainActor in callback?(reason) }
    }

    private func acceptOne() {
        let client = accept(listenFD, nil, nil)
        guard client >= 0 else { return }
        defer { close(client) }

        var tv = timeval(tv_sec: 1, tv_usec: 0)   // 1s receive timeout so a mute connection can't stall the accept loop
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        // Read in a loop: one read can return part of the line, and a
        // truncated line loses its last field, filing the event under a
        // garbage source.
        //
        // The line has four tab-separated fields and no terminator, so four
        // fields in hand with nothing more waiting is as complete as it gets.
        // Waiting for the peer to close would idle a whole receive timeout on
        // every event. The byte cap stops a wedged peer from growing this
        // without bound.
        var message = [UInt8]()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while message.count < Self.maxReconciliationBytes {
            let n = read(client, &chunk, chunk.count)
            if n <= 0 { break }   // peer closed, or the receive timeout hit
            message.append(contentsOf: chunk[0..<n])
            let isReconciliation = message.starts(with: Array("reconciliation\t".utf8))
            if !isReconciliation && message.count > 4096 { return }
            let tabs = message.filter { $0 == UInt8(ascii: "\t") }.count
            if !isReconciliation && n < chunk.count, tabs >= 3 { break }
        }
        guard !message.isEmpty, let text = String(bytes: message, encoding: .utf8) else { return }
        if text.hasPrefix("hook-ledger-request\t") {
            let parts = text.split(separator: "\t", omittingEmptySubsequences: false)
            guard parts.count == 4,
                  parts[3].trimmingCharacters(in: .whitespacesAndNewlines) == "reconciler",
                  let days = Int(parts[1]), (1...31).contains(days) else {
                respond(Data("ERR\tbad-request".utf8), to: client)
                return
            }
            respondWithHookLedger(to: client, lookbackDays: days)
            return
        }
        deliver(text)
    }

    private func respondWithHookLedger(to client: Int32, lookbackDays: Int) {
        let directory = DataHome.url.appendingPathComponent("agent-events")
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .isRegularFileKey]
        let cutoff = Date().addingTimeInterval(-TimeInterval(lookbackDays + 1) * 86_400)
        do {
            let files = try FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: Array(keys),
                options: [.skipsHiddenFiles]
            ).filter { url in
                guard url.pathExtension == "jsonl",
                      let values = try? url.resourceValues(forKeys: keys),
                      values.isRegularFile == true else { return false }
                return (values.contentModificationDate ?? .distantPast) >= cutoff
            }.sorted { $0.lastPathComponent < $1.lastPathComponent }

            var payload = Data("OK\n".utf8)
            for file in files {
                let bytes = try Data(contentsOf: file)
                if payload.count + bytes.count + 1 > Self.maxHookLedgerBytes {
                    respond(Data("ERR\ttoo-large".utf8), to: client)
                    return
                }
                payload.append(bytes)
                if payload.last != UInt8(ascii: "\n") { payload.append(UInt8(ascii: "\n")) }
            }
            respond(payload, to: client)
        } catch {
            respond(Data("ERR\tread-failed".utf8), to: client)
        }
    }

    private func respond(_ payload: Data, to client: Int32) {
        var noPipe: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout.size(ofValue: noPipe)))
        payload.withUnsafeBytes { raw in
            guard var base = raw.baseAddress else { return }
            var remaining = raw.count
            while remaining > 0 {
                let written = write(client, base, remaining)
                guard written > 0 else { return }
                remaining -= written
                base = base.advanced(by: written)
            }
        }
    }

    private func deliver(_ text: String) {
        // Format: <event>\t<projectDir>\t<nonce>\t<source>\t<host>\t<session>
        // A missing source counts as claude (see the callbacks above).
        let parts = text.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        // More fields than the format has means one of them held a tab, and every field after
        // it is in the wrong place.
        guard parts.count <= 6 else { return }
        func field(_ i: Int) -> String {
            parts.count > i ? parts[i].trimmingCharacters(in: .whitespacesAndNewlines) : ""
        }
        let event = field(0)
        let project = field(1)
        let rawSource = field(3).lowercased()
        let source = rawSource.isEmpty ? "claude" : rawSource
        let host = AgentHost(app: field(4), session: field(5))
        switch event {
        case "working":
            let cb = onWorking
            Task { @MainActor in cb?(project, source, host) }   // hop to the main thread without capturing non-Sendable self
        case "waiting":
            let cb = onWaiting
            Task { @MainActor in cb?(project, source, host) }
        case "complete":
            let cb = onComplete
            Task { @MainActor in cb?(project, source, host) }
        case "reconciliation":
            guard source == "reconciler",
                  let health = Data(base64Encoded: project),
                  let canonical = Data(base64Encoded: field(2)) else { break }
            onReconciliation?(health, canonical)
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
