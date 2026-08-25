import Foundation

// MARK: - Care ledger: the format contract
//
// This file defines the v1 on-disk format of the care ledger and the entry points that
// read and write it. The island writes a record whenever a guided move finishes, and other
// programs read it as JSON. It does not time sessions, choose moves, or draw anything.
//
// The ledger lives at `care-ledger.json` in the App Group container. The root object is:
//
//     { "version": 1, "records": [ ...each one as below... ] }
//
// A v1 record carries these seven fields; both the names and their meanings are part of
// the persisted format contract:
//
//     date      "2026-07-27"           local date (not UTC — it asks about a human's day)
//     moveId    "eye-orbital-massage"  move id
//     category  "eyes"                 body area, CareCategory's raw string
//     sets      1                      completed whole sets; rounding happens at the writer
//     seconds   40                     actual duration
//     source    "island"               who wrote it; the v1 writer always writes "island"
//     at        "2026-07-27T01:59:27Z" ISO8601 timestamp
//
// Downstream views rely on `date`, `sets` and `seconds`, and may treat a record they cannot
// parse as absent — deleting, renaming, or changing the meaning of those fields makes a
// day's data disappear silently. Before adding a field, confirm every reader ignores
// unknown keys. Any incompatible change to an existing field requires a format version
// bump and a migration of the old data.
//
// The current storage flow supports exactly one writer, the island. A second writer would
// let two read-modify-write cycles overwrite each other; before allowing concurrent
// writes, switch to a coordinated or genuinely append-only format first.

/// The persisted category shared by ledger records and the move catalog.
/// `rawValue` goes straight into the JSON, so renaming a case breaks the format and
/// requires migrating existing records.
enum CareCategory: String, Codable, CaseIterable, Equatable {
    case neck
    case shoulders
    case eyes
    case face
}

/// One v1 care record; see the format contract at the top of this file for field meanings.
struct CareRecord: Codable, Equatable, Identifiable {
    var date: String
    var moveId: String
    var category: CareCategory
    var sets: Int
    var seconds: Int
    var source: String
    var at: String

    var id: String { at + "-" + moveId }
}

/// The ledger's root object. Records are kept in append order, neither deduplicated nor
/// sorted here.
struct CareLedger: Codable, Equatable {
    var version: Int
    var records: [CareRecord]

    static let empty = CareLedger(version: 1, records: [])

    /// Appends a record to the end of the in-memory ledger; writing to disk is
    /// `CareLedgerStore`'s job.
    mutating func append(_ record: CareRecord) {
        records.append(record)
    }
}

/// Reads and replace-writes `care-ledger.json`.
///
/// Every method works on the real ledger in the App Group by default; `url` can point at a
/// temporary or migration file instead, with identical parsing and writing semantics. This
/// type does not coordinate multiple writers — callers must honor the single-writer
/// constraint stated at the top of this file.
enum CareLedgerStore {
    /// Where the real ledger sits inside the App Group container.
    static var ledgerURL: URL { AppGroup.containerURL.appendingPathComponent("care-ledger.json") }

    /// Loads the whole ledger.
    ///
    /// A missing file means there are no records yet and yields an empty v1 ledger; a file
    /// that exists but cannot be read or decoded throws.
    ///
    /// A corrupt file must never be treated as an empty ledger: the next append would then
    /// replace the entire old ledger with one new record, silently losing the history.
    static func load(from url: URL = ledgerURL) throws -> CareLedger {
        guard FileManager.default.fileExists(atPath: url.path) else { return .empty }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(CareLedger.self, from: data)
    }

    /// Writes the whole ledger to the given location.
    /// Creates the parent directory, encodes the JSON with stable key order and a trailing
    /// newline, and replaces the target file atomically; a failure to create the directory,
    /// encode, or write throws.
    static func save(_ ledger: CareLedger, to url: URL = ledgerURL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        var data = try encoder.encode(ledger)
        data.append(0x0A)
        try data.write(to: url, options: [.atomic])
    }

    /// Loads the current ledger, appends a record at the end, writes it back atomically,
    /// and returns the ledger as written.
    ///
    /// A failed load never reaches the save step, so the original file is left untouched;
    /// encoding and writing failures also propagate to the caller. Callers must hold on to
    /// a record that has not been written successfully so it can be retried. Because the
    /// whole file goes through read-modify-write, concurrent writes can still lose updates.
    @discardableResult
    static func append(_ record: CareRecord, to url: URL = ledgerURL) throws -> CareLedger {
        var ledger = try load(from: url)
        ledger.append(record)
        try save(ledger, to: url)
        return ledger
    }
}
