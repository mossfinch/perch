import Foundation

/// `Perch --demo`: the island with made-up projects and a made-up week, for recording what it
/// looks like. `AppGroup` swaps the container for a scratch directory; this fills it.
///
/// The scratch directory is seeded with a week of events before the island reads anything,
/// and a short script then pushes events into the demo socket the way the hooks do, so what
/// the recording shows comes out of the same code a real day goes through. Real agents cannot
/// reach this island: their hooks push to the socket in the real container.
enum DemoMode {
    /// Before the island is built: it reads the week as it starts.
    static func seed() {
        seedWeek(into: AppGroup.containerURL.appendingPathComponent("agent-events"), now: Date())
    }

    /// Hours of quick hand-offs on each past day of this week, chosen to land on different
    /// levels of the branch.
    private static let pastDays: [Double] = [2.6, 4.4, 1.4, 6.3, 3.2, 5.1]

    private static let projects = [("/demo/storefront", "claude"), ("/demo/notes-api", "codex")]

    /// Monday up to yesterday get a stretch starting at ten in the morning. Today gets an
    /// unbroken hour ending just now, so the first hand-off of the script is the one that asks
    /// for a break.
    private static func seedWeek(into directory: URL, now: Date) {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        let weekday = calendar.component(.weekday, from: today)
        let daysSinceMonday = (weekday + 5) % 7
        for back in stride(from: daysSinceMonday, to: 0, by: -1) {
            guard let day = calendar.date(byAdding: .day, value: -back, to: today) else { continue }
            let hours = pastDays[(daysSinceMonday - back) % pastDays.count]
            seedRun(from: day.addingTimeInterval(10 * 3600), for: hours * 3600, into: directory)
        }
        // Eighteen turns of 220 seconds, the last one finished thirty seconds ago: well inside
        // the five minutes that would count as a pause, and over the hour that earns an ask.
        let turns = 18.0
        seedRun(from: now.addingTimeInterval(-30 - turns * 220 + 40), for: turns * 220 - 1, into: directory)
    }

    /// Three-minute turns picked up within forty seconds, alternating between the two projects.
    private static func seedRun(from start: Date, for length: TimeInterval, into directory: URL) {
        var t = start
        var turn = 0
        while t.timeIntervalSince(start) < length {
            let (project, source) = projects[turn % projects.count]
            AgentEventLog.write(project: project, source: source, event: "working", at: t, into: directory)
            t += 180
            AgentEventLog.write(project: project, source: source, event: "complete", at: t, into: directory)
            t += 40
            turn += 1
        }
    }

    /// Seconds after launch, then the line a hook would push.
    private static let script: [(TimeInterval, String, String, String)] = [
        (2, "working", "/demo/storefront", "claude"),
        (6, "working", "/demo/notes-api", "codex"),
        (8, "waiting", "/demo/notes-api", "codex"),
        (11, "working", "/demo/notes-api", "codex"),
        (14, "complete", "/demo/storefront", "claude"),
        (18, "complete", "/demo/notes-api", "codex"),
    ]

    static func runScript() {
        for (delay, event, project, source) in script {
            DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
                push("\(event)\t\(project)\t\(Int(Date().timeIntervalSince1970))-demo\t\(source)")
            }
        }
    }

    private static func push(_ line: String) {
        let path = AppGroup.containerURL.appendingPathComponent(AgentEventMonitor.socketFileName).path
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        defer { close(fd) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < capacity else { return }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuple in
            tuple.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                _ = path.withCString { strncpy(dst, $0, capacity - 1) }
            }
        }
        let connected = withUnsafePointer(to: &addr) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { return }
        _ = line.withCString { write(fd, $0, strlen($0)) }
    }
}
