import Foundation

/// The waits someone can pick for the stretch reminder, and how each one is said.
///
/// The choice is offered where it is wanted: in the sentence the card shows after a move that
/// answered a reminder, and in the right-click menu (the only way back once asks are off).
enum StretchInterval {
    /// Minutes, shortest first; nil is never.
    static let choices: [Int?] = [30, 45, 60, 90, nil]

    /// Whether a longer wait than this one is on offer. At the longest, offering a change after
    /// a slow answer would leave only "Never" to pick, which talks someone out of the reminder.
    static func canLengthen(_ minutes: Int?) -> Bool {
        guard let minutes, let longest = choices.compactMap({ $0 }).max() else { return false }
        return minutes < longest
    }

    /// The short name, for the row of choices and the menu.
    static func label(_ minutes: Int?) -> String {
        switch minutes {
        case nil: return "Never"
        case 60: return "1 hour"
        case let m?: return "\(m) min"
        }
    }

    /// The words that fill "Next nudge after ___ of work."
    static func spoken(_ minutes: Int) -> String {
        switch minutes {
        case 30: return "half an hour"
        case 60: return "an hour"
        case 90: return "an hour and a half"
        default: return "\(minutes) minutes"
        }
    }

    /// The pick as the reminder counts it.
    static func seconds(_ minutes: Int?) -> TimeInterval? {
        minutes.map { TimeInterval($0) * 60 }
    }

    private static let key = "stretchIntervalMinutes"

    /// What is stored for never; zero minutes is not a choice.
    private static let never = 0

    /// The stored choice, or the default when nothing was picked or the stored value is not
    /// one of the choices.
    static func load(_ defaults: UserDefaults = .standard) -> Int? {
        guard defaults.object(forKey: key) != nil else { return Int(StretchNudge.after / 60) }
        let stored = defaults.integer(forKey: key)
        if stored == never { return nil }
        return choices.contains(stored) ? stored : Int(StretchNudge.after / 60)
    }

    static func save(_ minutes: Int?, _ defaults: UserDefaults = .standard) {
        defaults.set(minutes ?? never, forKey: key)
    }
}

extension StretchNudge.Memory {
    private static let key = "stretchMemory"

    /// The stored memory, or an empty one when nothing was stored or it cannot be read: an
    /// unreadable memory costs one repeated ask, never a missing one.
    static func load(_ defaults: UserDefaults = .standard) -> Self {
        guard let data = defaults.data(forKey: key),
              let memory = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return memory
    }

    /// Writes only a change: this runs on every refresh, every 15 seconds.
    static func save(_ memory: Self, _ defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(memory), data != defaults.data(forKey: key) else { return }
        defaults.set(data, forKey: key)
    }
}
