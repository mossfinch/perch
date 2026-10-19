import AppKit

/// The island's three sounds. Loaded once and kept, because `NSSound` is slow to open and
/// the beat has to land on the frame it marks.
///
/// Static, because stored properties cannot live in an extension.
extension IslandViewModel {
    /// A line finished. Played for every completion, unless the speaker is muted.
    static let completionSound: NSSound? = {
        let sound = Bundle.main.url(forResource: "CompletionChime", withExtension: "aiff")
            .flatMap { NSSound(contentsOf: $0, byReference: false) }   // audio from the app's own bundle; the sandbox allows that
            ?? NSSound(named: "Funk")
        sound?.volume = 1.0
        return sound
    }()

    /// A line is waiting for your approval or your choice. A different sound from the
    /// completion on purpose: "come back and decide" is more urgent than "it finished", and
    /// you should be able to tell which from across the room. Muted by the same speaker.
    static let waitingSound: NSSound? = {
        let sound = NSSound(named: "Glass")
        sound?.volume = 1.0
        return sound
    }()

    /// The frame-change tick. Side-neck and levator stretches are done with your
    /// head turned away from the screen, where visual progress is useless and
    /// only sound keeps up.
    /// The audio is synthesized by artifacts/island-sounds/make_beat_tick.py
    /// from a fixed seed, so it is reproducible.
    static let beatSound: NSSound? = {
        let sound = Bundle.main.url(forResource: "BeatTick", withExtension: "aiff")
            .flatMap { NSSound(contentsOf: $0, byReference: false) }
            ?? NSSound(named: "Bottle")   // fallback: never go mute even if the resource missed the bundle
        sound?.volume = 1.0    // full volume: any quieter and ambient noise swallows the tick
        return sound
    }()

    static func play(_ sound: NSSound?) {
        sound?.stop()
        if sound?.play() != true {
            NSSound.beep()   // fallback: if the named sound fails, the system beep guarantees something is heard
        }
    }
}
