import Foundation

/// Disposable health summary published by the non-sandbox reconciler.
/// Provider history stays outside the sandbox; no prompt or response body
/// enters this app process or its App Group.
struct SourceHealthSnapshot: Decodable {
    struct Source: Decodable {
        let status: String
        let freshnessStatus: String
        let nativeTurns: Int

        enum CodingKeys: String, CodingKey {
            case status
            case freshnessStatus = "freshness_status"
            case nativeTurns = "native_turns"
        }
    }

    struct Alert: Decodable {
        let source: String
        let kind: String
        let count: Int
    }

    let schemaVersion: Int
    let generatedAt: Date
    let sources: [String: Source]
    let alerts: [Alert]

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case generatedAt = "generated_at"
        case sources
        case alerts
    }

    static func decode(_ data: Data) throws -> Self {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) { return date }
            let plain = ISO8601DateFormatter()
            if let date = plain.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Invalid RFC3339 date")
        }
        let snapshot = try decoder.decode(Self.self, from: data)
        guard snapshot.schemaVersion == 1 else { throw CocoaError(.coderReadCorrupt) }
        return snapshot
    }

}

enum SourceHealthStore {
    /// The scanner cannot write a Team App Group from a plain LaunchAgent on
    /// current macOS. Validate its bounded socket payload, then let this signed
    /// app publish both disposable files. Health is written last and acts as
    /// the commit marker: readers never see a new health summary paired with
    /// the previous canonical cache.
    static func publish(
        health: Data,
        canonical: Data,
        directory: URL = AppGroup.containerURL.appendingPathComponent(
            "reconciliation", isDirectory: true)
    ) throws {
        _ = try SourceHealthSnapshot.decode(health)
        guard let text = String(data: canonical, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        var identifiers = Set<String>()
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let object = try JSONSerialization.jsonObject(with: Data(line.utf8))
            guard let record = object as? [String: Any],
                  let identifier = record["record_id"] as? String,
                  !identifier.isEmpty,
                  record["reconstructed"] as? Bool == true,
                  identifiers.insert(identifier).inserted else {
                throw CocoaError(.fileReadCorruptFile)
            }
        }
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true)
        try canonical.write(
            to: directory.appendingPathComponent("canonical-turns.jsonl"),
            options: .atomic)
        try health.write(
            to: directory.appendingPathComponent("source-health.json"),
            options: .atomic)
    }
}
