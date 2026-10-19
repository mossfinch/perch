import SwiftUI

/// The title line for a few seconds after a move that answered a reminder: one sentence
/// saying when the next one comes, with the time in it pressable to pick another.
///
/// It is the only place on the card the wait is offered. It shows at the one moment someone
/// is thinking about it, in the line that already holds words, and the rest of the card stays
/// as it is. One `Text` with the time as a link, so the whole sentence shrinks together when
/// a longer wait would not fit beside the controls.
struct NudgeSentence: View {
    let minutes: Int?
    @Binding var choosing: Bool
    /// Called when the sentence has had its moment and the move's name and Start come back.
    let onExpire: () -> Void

    /// Long enough to read it and press the time; past that the card needs its Start back.
    /// Not while the choices are open: they never vanish under the pointer.
    static let shown: Duration = .seconds(10)

    var body: some View {
        Text(words)
            .font(.system(size: 22, weight: .semibold))   // the title's own type: it stands in the title's place
            .foregroundStyle(IslandPalette.paper)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .environment(\.openURL, OpenURLAction { _ in
                withAnimation(.easeInOut(duration: 0.18)) { choosing.toggle() }
                return .handled
            })
            .accessibilityHint("Choose how long work runs before a reminder")
            .task {
                do {
                    try await Task.sleep(for: Self.shown)
                    while choosing { try await Task.sleep(for: .seconds(1)) }
                } catch {
                    return   // the sentence went away first
                }
                onExpire()
            }
    }

    private var words: AttributedString {
        let (before, time, after) = minutes.map { ("Next nudge after ", StretchInterval.spoken($0), " of work.") }
            ?? ("Nudges are ", "off", ".")
        var link = AttributedString(time)
        link.link = URL(string: "perch-wait:choose")
        link.foregroundColor = WeekPerch.paint
        link.underlineStyle = .single
        return AttributedString(before) + link + AttributedString(after)
    }
}

/// The waits, floating just under the title once the time in the sentence is pressed.
struct NudgeChoices: View {
    let minutes: Int?
    let choose: (Int?) -> Void

    var body: some View {
        HStack(spacing: 22) {
            ForEach(StretchInterval.choices, id: \.self) { option in
                Button { choose(option) } label: {
                    Text(StretchInterval.label(option))
                        .font(.system(size: 15, weight: .light))
                        .foregroundStyle(option == minutes ? WeekPerch.paint : IslandPalette.paper.opacity(0.38))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.11)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(IslandPalette.paper.opacity(0.1), lineWidth: 1))
        .fixedSize()
    }
}
