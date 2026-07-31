import Foundation

// MARK: - Care ledger: the format contract
//
// The island is the ONLY writer; the ledger is the island's own data (which
// care moves you have done). Other programs are readers — they read it from
// the agreed location: **deliver in the agreed format, share no code**.
//
// File: `care-ledger.json` in the App Group container. The whole file is one
// object:
//
//     { "version": 1, "records": [ ...each as below... ] }
//
// A record has exactly seven fields. **Changing any of them changes the
// contract and breaks the readers**:
//
//     date      "2026-07-27"           local date (not UTC — it asks about a human's day)
//     moveId    "eye-orbital-massage"  move id
//     category  "eyes"                 body area, CareCategory's raw string
//     sets      1                      completed whole sets; partial sets don't round up
//     seconds   40                     actual duration
//     source    "island"               who wrote it; always "island" in v1
//     at        "2026-07-27T01:59:27Z" ISO8601 timestamp
//
// ⚠️ Known readers use only date / sets / seconds. Deleting or renaming those
// breaks them — and SILENTLY: whatever they cannot parse they treat as
// absent, so a day quietly disappears from their view instead of raising.
// Adding new fields is safe (readers ignore unknown keys); deleting and
// renaming are not.

/// Care categories — deliberately a standalone enum.
enum CareCategory: String, Codable, CaseIterable, Equatable {
    case neck
    case shoulders
    case eyes
    case face
}

/// One care record (see the format contract above).
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

struct CareLedger: Codable, Equatable {
    var version: Int
    var records: [CareRecord]

    static let empty = CareLedger(version: 1, records: [])

    mutating func append(_ record: CareRecord) {
        records.append(record)
    }
}

/// Reads and writes `care-ledger.json`. The island is the only writer.
///
/// All three methods take a URL (defaulting to the real ledger). This seam
/// exists so **real behavior can be tested with real code**: questions like
/// "does an unparsable file get wiped?" must be answerable by feeding a fake
/// file and asserting, not by grepping the source for words.
enum CareLedgerStore {
    /// Container: see `AppGroup.swift`. Does NOT depend on the socket
    /// listener — the ledger has no business with the socket.

    static var ledgerURL: URL { AppGroup.containerURL.appendingPathComponent("care-ledger.json") }

    /// Load the whole ledger. **"Missing" and "unreadable" are different
    /// things and must stay separate**:
    ///
    /// - File absent → empty ledger. Normal state (no sessions yet).
    /// - File present but unparsable → **throw**, never return empty.
    ///
    /// If unparsable were swallowed into an empty ledger: recording goes
    /// "load → append one → write back whole", so the next session would
    /// overwrite the entire history with ONE new record, without a sound.
    /// Hence: throw.
    static func load(from url: URL = ledgerURL) throws -> CareLedger {
        guard FileManager.default.fileExists(atPath: url.path) else { return .empty }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(CareLedger.self, from: data)
    }

    static func save(_ ledger: CareLedger, to url: URL = ledgerURL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        var data = try encoder.encode(ledger)
        data.append(0x0A)
        try data.write(to: url, options: [.atomic])
    }

    /// The only entry point for recording: load → append → save, replacing
    /// the whole file atomically.
    ///
    /// If the load step cannot parse, it throws RIGHT THERE and save is never
    /// reached — the old ledger keeps every byte. The caller
    /// (`persistCareSession`) can handle it: hold on to the record, switch to
    /// paused, make a sound.
    ///
    /// ⚠️ This is read-modify-write: valid only while the island is the sole
    /// writer. A second writer would first require an append-only,
    /// line-per-record format, or the two would overwrite each other.
    @discardableResult
    static func append(_ record: CareRecord, to url: URL = ledgerURL) throws -> CareLedger {
        var ledger = try load(from: url)
        ledger.append(record)
        try save(ledger, to: url)
        return ledger
    }
}
