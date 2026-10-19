// The Record window: every week since the log began, one drawn large.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together; a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { islandPath } = require("./island-paths");

const read = (name) => fs.readFileSync(islandPath(name), "utf8");
const code = (s) => s.replace(/\/\/.*$/gm, "");

test("the record groups real readings into Monday weeks and seats the bird where it means something", () => {
  // Behaviour, compiled and run: RecordData is plain Foundation so this can build it alone.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-record-"));
  const main = path.join(tmp, "main.swift");
  fs.writeFileSync(main, `
import Foundation
var cal = Calendar(identifier: .gregorian)
cal.timeZone = TimeZone(identifier: "Asia/Shanghai")!
let f = DateFormatter(); f.calendar = cal; f.timeZone = cal.timeZone; f.dateFormat = "yyyy-MM-dd"
func d(_ s: String) -> Date { f.date(from: s)! }

// Monday-first weeks from the first logged day to today, oldest first.
let mondays = RecordData.mondays(from: d("2026-07-29"), to: d("2026-10-17").addingTimeInterval(3600 * 15), calendar: cal)
precondition(mondays.map { f.string(from: $0) }.first == "2026-07-27", "the first week does not start on its Monday")
precondition(mondays.map { f.string(from: $0) }.last == "2026-10-12", "the last week is not the one holding today")
precondition(mondays.count == 12, "weeks missing or doubled: \\(mondays.count)")
// A Sunday belongs to the week before it, whatever the locale's first weekday.
precondition(f.string(from: RecordData.monday(of: d("2026-10-18"), calendar: cal)!) == "2026-10-12", "Sunday started a new week")

// A past week is read to the last second of its Sunday; this week only up to now.
let now = d("2026-10-17").addingTimeInterval(3600 * 15)
precondition(RecordData.readingTime(monday: d("2026-10-05"), now: now, calendar: cal) == d("2026-10-12").addingTimeInterval(-1))
precondition(RecordData.readingTime(monday: d("2026-10-12"), now: now, calendar: cal) == now)

func reading(_ date: String, _ minutes: Double, judged: Bool = true, lived: Bool = true) -> RecordData.Reading {
    RecordData.Reading(date: date, seconds: minutes * 60, level: 1, judged: judged, lived: lived)
}
let moves = RecordData.movesByDate([(date: "2026-10-13", moveID: "chin-tuck"), (date: "2026-10-13", moveID: "eye"),
                                    (date: "2026-10-13", moveID: "chin-tuck"), (date: "2026-10-18", moveID: "eye")]) { $0.uppercased() }
precondition(moves["2026-10-13"] == ["CHIN-TUCK", "EYE", "CHIN-TUCK"], "moves lost their order or their names")

// This week: the bird sits on today, the last lived day, as it does on the card.
let current = RecordData.week(monday: "2026-10-12", readings: [
    reading("2026-10-12", 300), reading("2026-10-13", 90), reading("2026-10-14", 10), reading("2026-10-15", 0),
    reading("2026-10-16", 0, judged: false), reading("2026-10-17", 20),
    reading("2026-10-18", 0, judged: false, lived: false)], moves: moves, isCurrent: true)
precondition(current.birdIndex == 5, "this week's bird is not on today")
precondition(current.days[6].moves.isEmpty, "a day not lived yet carries moves")
precondition(current.moveCount == 3, "moves miscounted: \\(current.moveCount)")

// A past week: the bird sits on the day with the most flow; an unjudged day never wins.
let past = RecordData.week(monday: "2026-10-05", readings: [
    reading("2026-10-05", 100), reading("2026-10-06", 900, judged: false), reading("2026-10-07", 250),
    reading("2026-10-08", 40), reading("2026-10-09", 0), reading("2026-10-10", 0), reading("2026-10-11", 0)],
    moves: [:], isCurrent: false)
precondition(past.birdIndex == 2, "the past week's bird is not on its best measured day")
let empty = RecordData.week(monday: "2026-07-20", readings: (0..<7).map { reading("x\\($0)", 0, judged: false) }, moves: [:], isCurrent: false)
precondition(empty.birdIndex == nil, "a week with nothing measured still got a bird")

// The words, the card's way.
precondition(RecordData.weekFlow(59 * 60) == "59 minutes")
precondition(RecordData.weekFlow(60 * 60) == "1 hour")
precondition(RecordData.weekFlow(12.4 * 3600) == "12 hours")
precondition(RecordData.stretches(1) == "1 stretch" && RecordData.stretches(19) == "19 stretches")
precondition(RecordData.dayFlow(current.days[4]) == nil, "an unjudged day claims a reading")
precondition(RecordData.dayFlow(current.days[3]) == "0m", "a measured zero must read 0m, not nothing")
precondition(RecordData.dayFlow(current.days[0]) == "5h 0m")
precondition(RecordData.dayFlow(current.days[2]) == "10m")
precondition(RecordData.strokeHeights([empty]) == [0], "nothing measured anywhere divided by zero")

// Kept on disk between launches, for the build that measured it only; a bad file is no file.
let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("record-cache-\(UUID().uuidString).json")
let kept: [String: RecordData.Cache.Week] = ["2026-10-05": .init(key: "120@1.0|-", readings: [reading("2026-10-05", 100)])]
let here = RecordData.Cache.identity(build: "132", timeZone: "Asia/Shanghai")
RecordData.Cache.save(kept, identity: here, to: file)
precondition(RecordData.Cache.load(from: file, identity: here) == kept, "the weeks did not come back as they were stored")
precondition(RecordData.Cache.load(from: file, identity: RecordData.Cache.identity(build: "133", timeZone: "Asia/Shanghai")).isEmpty,
             "an update trusted weeks measured by the old build")
// Codex 10-18: days are cut at local midnight, so another time zone measures other numbers.
precondition(RecordData.Cache.load(from: file, identity: RecordData.Cache.identity(build: "132", timeZone: "Europe/London")).isEmpty,
             "weeks measured in another time zone were trusted")
try! Data("{".utf8).write(to: file)
precondition(RecordData.Cache.load(from: file, identity: here).isEmpty, "a broken file was read as weeks")
precondition(RecordData.Cache.load(from: file.appendingPathExtension("gone"), identity: here).isEmpty)
print("ok")
`);
  const binary = path.join(tmp, "record");
  execFileSync("swiftc", [islandPath("RecordData.swift"), main, "-o", binary], { stdio: "pipe" });
  assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "ok");
  assert.doesNotMatch(read("RecordData.swift"), /import (AppKit|SwiftUI)/, "a UI import makes the data untestable again");
});

test("a day reads the same in the record as on the card", () => {
  // The record measures nothing: every reading is DayFlow's, the very call the card's
  // branch makes, with the hand corrections applied the way the card applies them.
  const store = code(read("RecordStore.swift"));
  assert.match(store, /DayFlow\.week\(now: at, calendar: calendar\)/, "the record stopped taking its readings from DayFlow");
  assert.doesNotMatch(store, /FlowSense\.|FlowMath\.|seconds\(turns:/, "the record started measuring on its own");
  assert.match(store, /if let level = corrections\[r\.date\] \{ r\.level = level \}/, "a corrected day paints its machine level");
  // The words for a day follow the card's rule exactly.
  const rule = /minutes < 60 \? "\\\(minutes\)m" : "\\\(minutes \/ 60\)h \\\(minutes % 60\)m"/;
  assert.match(read("TopWeekRow.swift"), rule, "control: the card's rule changed shape, this check reads nothing");
  assert.match(read("RecordData.swift"), rule, "the record writes a day's flow differently from the card");
  // The same paint as the card's branch, not a lookalike.
  const view = code(read("RecordView.swift"));
  assert.match(view, /WeekPerch\.composited\(level: day\.level\)/);
  assert.match(view, /IslandPalette\.paper\.opacity\(WeekPerch\.unlived\)/);
});

test("the record reads off the main thread, keeps past weeks, and says when the moves cannot be read", () => {
  const store = code(read("RecordStore.swift"));
  assert.match(store, /Task\.detached/, "a year of replays would freeze the window");
  assert.match(store, /for index in mondays\.indices\.reversed\(\)/, "this week must come first, then back in time");
  // Only past weeks are kept, and only while their day files are unchanged.
  assert.match(store, /if !isCurrent, let hit = cached\[mondayKey\], hit\.key == fileKey/);
  assert.match(store, /if !isCurrent \{ self\.cache\[mondayKey\] = \.init\(key: fileKey, readings: readings\) \}/);
  // …and on disk, so a relaunch measures only this week: read once, written after the last week.
  assert.match(store, /private lazy var cache = RecordData\.Cache\.load\(from: Self\.cacheURL, identity: Self\.identity\)/,
    "a relaunch measures every week again");
  assert.match(store, /measured != cached, !Task\.isCancelled \{\s*RecordData\.Cache\.save\(measured, identity: Self\.identity, to: Self\.cacheURL\)/);
  assert.match(store, /timeZone: TimeZone\.current\.identifier/, "the cache stopped telling time zones apart");
  // Codex 10-18: nothing measured on the main thread, and a replaced load writes nothing.
  assert.doesNotMatch(store, /DayFlow\.read\(/, "opening the record measures this week on the main thread again");
  assert.match(store, /Task\.detached\(priority: \.userInitiated\) \{ \[weak self\] in[\s\S]*?let corrections = Self\.corrections\(\)/);
  assert.match(store, /guard let self, self\.generation == generation, self\.weeks\.indices\.contains\(index\)/,
    "a replaced load can still overwrite the new one");
  assert.match(store, /guard let self, self\.generation == generation else \{ return nil \}\s*return self\.cache/,
    "a replaced load can still write the cache");
  assert.match(store, /DataHome\.url\.appendingPathComponent\("record-cache\.json"\)/, "the cache left Perch's own folder (or the demo's)");
  // An unreadable ledger is said out loud, never shown as a record with no moves.
  assert.match(store, /catch \{\s*return \(\[:\], "Couldn't read your moves:/);
  assert.match(code(read("RecordView.swift")), /if let problem = store\.ledgerProblem \{ return problem \}/);
});

test("the record lives in the card: today's reading or the menu swaps it in, closing the card puts the move back", () => {
  // No window of its own: a separate window just to keep a record felt out of place.
  const { islandTree } = require("./island-paths");
  assert.ok(!islandTree().some((p) => p.endsWith("RecordWindow.swift")), "the record window came back");
  const card = code(read("GuidedCareCard.swift"));
  assert.match(card, /if viewModel\.showingRecord \{\s*RecordView\(store: RecordStore\.shared, onClose: \{ viewModel\.toggleRecord\(\) \}\)[\s\S]*?\} else \{\s*mainContent/,
    "the card no longer swaps its lower half for the record");
  const vm = fs.readFileSync(islandPath("IslandViewModel.swift"), "utf8");
  assert.match(vm, /showingRecord = false   \/\/ the card always opens on the move/, "a record left open would greet the next opening");
  const week = code(fs.readFileSync(islandPath("IslandViewModel+Week.swift"), "utf8"));
  assert.match(week, /func toggleRecord\(\) \{\s*if !showingRecord \{ RecordStore\.shared\.reload\(\) \}/);
  const menu = code(read("IslandMenu.swift"));
  assert.match(menu, /NSMenuItem\(title: "Record", action: #selector\(openRecord\)/);
  assert.match(menu, /func openRecord\(\) \{\s*viewModel\.toggleRecord\(\)/);
  // Only a reading opens it: a finished project's name opens its app, and the break line opens nothing.
  const row = code(read("TopWeekRow.swift"));
  assert.match(row, /\} else if resting\.isReading, !nudge \{\s*onRecord\(\)/);
  assert.match(row, /onRecord: \{ viewModel\.toggleRecord\(\) \}/);
  // Choosing a week is a real button, so the keyboard and VoiceOver can do it too.
  assert.match(code(read("RecordView.swift")), /Button \{ chosen = i \} label:/);
});

test("the record's small words stay short, its strokes stay grey, and no hover outlives the view", () => {
  const view = code(read("RecordView.swift"));
  // A week reads from its Monday to its Sunday, a hovered day as "Thu, Oct 15": the old wording ran past the card.
  assert.match(view, /guard let week, let hovered else \{ return Self\.weekSpan\(monday\) \}/);
  assert.match(view, /return "\\\(Self\.weekdays\[hovered\]\.prefix\(3\)\), \\\(Self\.shortDate\(week\.days\[hovered\]\.date\)\)"/);
  assert.match(view, /return "\\\(start\.formatted\(\.dateTime\.month\(\.abbreviated\)\.day\(\)\)\) – \\\(last\)"/);
  assert.doesNotMatch(view, /"The week of /, "the caption is back to the long sentence");
  assert.doesNotMatch(view, /joined\(separator: ", "\)/, "the caption lists move names again");
  // Only the chosen week is painted; the paint dimmed on black reads brown, so the rest are grey wood.
  assert.match(view, /return i == index \? WeekPerch\.paint : IslandPalette\.paper\.opacity\(WeekPerch\.unlived\)/);
  assert.doesNotMatch(view, /WeekPerch\.paint\.opacity\(/, "a dimmed paint is back on the timeline");
  // Short month names, and a month that starts within two strokes of the next gives way.
  assert.match(view, /\.month\(\.abbreviated\)/);
  assert.match(view, /let next = \(i \+ 1\)\.\.<min\(i \+ 3, store\.weeks\.count\)\s*return next\.contains \{ monthLabel\(\$0\) != nil \} \? nil : label/);
  // A hover the panel never ended is cleared when the record comes and goes.
  assert.match(view, /\.onAppear \{ hovered = nil \}\s*\.onDisappear \{ hovered = nil \}/);
});

test("one branch on the card at a time: the record puts the top row away and closes from its own line", () => {
  // The top row's branch, the wave, then the record's branch read as the same week drawn twice;
  // hiding just the branch left today's reading stranded alone on its row.
  const card = code(read("GuidedCareCard.swift"));
  assert.match(card, /if !viewModel\.showingRecord \{\s*TopWeekRow\(viewModel: viewModel\)/, "the top row stays up while the record is open");
  // With the reading gone, the record needs its own way back, and a real button for it.
  const view = code(read("RecordView.swift"));
  assert.match(view, /Button \{ onClose\(\) \} label: \{\s*Text\("Back"\)/, "the record lost its way back to the move");
  assert.match(view, /\.underline\(pointerOnBack\)[\s\S]*?\.onHover \{ pointerOnBack = \$0 \}/);
  // Thin strokes, each centred in an equal share of the full width: not bunched left, not fat blocks.
  assert.match(view, /\.frame\(width: Self\.strokeWidth, height: store\.weeks\[i\] == nil \? 3 : 4 \+ 26 \* share\)\s*\.frame\(maxWidth: \.infinity, maxHeight: \.infinity, alignment: \.bottom\)/,
    "the strokes no longer spread thin over the whole width");
  assert.match(view, /static let strokeWidth: CGFloat = 6\b/);
  // The card's spare height goes above and below the week, so the strokes sit at the bottom.
  assert.match(view, /Spacer\(minLength: 12\)\s*branch[\s\S]*?Spacer\(minLength: 14\)\s*timeline/, "the strokes float up with an empty band under them");
});
