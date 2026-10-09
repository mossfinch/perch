import Foundation

/// JSON read and written the way Python's `json` module reads and writes it, byte for byte.
///
/// The hook installers exist twice: as Python scripts for people who build from source, and
/// inside the app for people who download it. Both rewrite files that belong to the user, so
/// both must leave the same bytes behind, and the Python scripts are the reference.
/// `JSONSerialization` cannot do that. It forgets the order of keys, and handing someone their
/// settings back in a new order is a change they never asked for.
///
/// Anything Python would accept but this reader cannot hold (a lone surrogate, a `\u` escape
/// that is not four hex digits) is refused. Refusing writes nothing, and the Python installer
/// is still there for that file.
indirect enum OrderedJSON {
    case object([Member])
    case array([OrderedJSON])
    case string(String)
    /// The literal digits. Python reads an integer exactly, at any size, so a `Double` would
    /// round a large one that Python writes back unchanged.
    case integer(String)
    case float(Double)
    case bool(Bool)
    case null

    struct Member {
        var key: String
        var value: OrderedJSON
    }

    struct ParseError: Error, CustomStringConvertible {
        let description: String
    }

    // MARK: Objects

    subscript(key: String) -> OrderedJSON? {
        guard case .object(let members) = self else { return nil }
        return members.first { Self.sameKey($0.key, key) }?.value
    }

    /// Python's `d[key] = value`: an existing key keeps its place, a new one goes last.
    mutating func set(_ key: String, _ value: OrderedJSON) {
        guard case .object(var members) = self else { return }
        if let at = members.firstIndex(where: { Self.sameKey($0.key, key) }) {
            members[at].value = value
        } else {
            members.append(Member(key: key, value: value))
        }
        self = .object(members)
    }

    /// Keys are compared scalar by scalar, as Python compares them. Swift's `==` on strings
    /// treats canonically equivalent spellings as equal, and Python does not.
    static func sameKey(_ a: String, _ b: String) -> Bool {
        a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }

    // MARK: Equality

    /// Python's `==`: dicts ignore order, `1 == 1.0` and `True == 1`.
    static func pyEqual(_ a: OrderedJSON, _ b: OrderedJSON) -> Bool {
        switch (a, b) {
        case (.null, .null):
            return true
        case (.string(let x), .string(let y)):
            return sameKey(x, y)
        case (.array(let x), .array(let y)):
            return x.count == y.count && zip(x, y).allSatisfy { pyEqual($0, $1) }
        case (.object(let x), .object(let y)):
            guard x.count == y.count else { return false }
            let right = OrderedJSON.object(y)
            return x.allSatisfy { member in
                right[member.key].map { pyEqual(member.value, $0) } ?? false
            }
        case (.integer(let x), .integer(let y)):
            return normalizedInteger(x) == normalizedInteger(y)
        default:
            guard let x = a.numberValue, let y = b.numberValue else { return false }
            return x == y
        }
    }

    private var numberValue: Double? {
        switch self {
        case .integer(let digits): return Double(digits)
        case .float(let value): return value
        case .bool(let flag): return flag ? 1 : 0
        default: return nil
        }
    }

    private static func normalizedInteger(_ digits: String) -> String {
        digits == "-0" ? "0" : digits
    }

    // MARK: Parsing

    /// `json.load` on a file read as UTF-8.
    static func parse(_ data: Data) throws -> OrderedJSON {
        if data.starts(with: [0xEF, 0xBB, 0xBF]) {
            throw ParseError(description: "starts with a UTF-8 byte order mark")
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw ParseError(description: "not valid UTF-8")
        }
        var reader = Reader(scalars: Array(text.unicodeScalars))
        reader.skipSpace()
        let value = try reader.value()
        reader.skipSpace()
        guard reader.atEnd else { throw reader.fail("extra data") }
        return value
    }

    private struct Reader {
        let scalars: [Unicode.Scalar]
        var at = 0

        var atEnd: Bool { at >= scalars.count }
        var current: Unicode.Scalar? { atEnd ? nil : scalars[at] }

        func fail(_ what: String) -> ParseError {
            ParseError(description: "\(what) at character \(at)")
        }

        mutating func skipSpace() {
            while let c = current, c == " " || c == "\t" || c == "\n" || c == "\r" { at += 1 }
        }

        mutating func consume(_ word: String) -> Bool {
            let wanted = Array(word.unicodeScalars)
            guard at + wanted.count <= scalars.count,
                  Array(scalars[at..<at + wanted.count]) == wanted else { return false }
            at += wanted.count
            return true
        }

        mutating func value() throws -> OrderedJSON {
            guard let c = current else { throw fail("expecting value") }
            switch c {
            case "\"": return .string(try string())
            case "{": return try object()
            case "[": return try array()
            default: break
            }
            if consume("null") { return .null }
            if consume("true") { return .bool(true) }
            if consume("false") { return .bool(false) }
            if let number = try number() { return number }
            if consume("NaN") { return .float(.nan) }
            if consume("Infinity") { return .float(.infinity) }
            if consume("-Infinity") { return .float(-.infinity) }
            throw fail("expecting value")
        }

        mutating func object() throws -> OrderedJSON {
            at += 1
            skipSpace()
            var result = OrderedJSON.object([])
            if current == "}" {
                at += 1
                return result
            }
            while true {
                guard current == "\"" else { throw fail("expecting property name") }
                let key = try string()
                skipSpace()
                guard current == ":" else { throw fail("expecting ':'") }
                at += 1
                skipSpace()
                // A repeated key keeps the place of its first appearance and the value of its
                // last, as building a dict from the pairs does.
                result.set(key, try value())
                skipSpace()
                if current == "}" {
                    at += 1
                    return result
                }
                guard current == "," else { throw fail("expecting ',' or '}'") }
                at += 1
                skipSpace()
            }
        }

        mutating func array() throws -> OrderedJSON {
            at += 1
            skipSpace()
            var items: [OrderedJSON] = []
            if current == "]" {
                at += 1
                return .array(items)
            }
            while true {
                items.append(try value())
                skipSpace()
                if current == "]" {
                    at += 1
                    return .array(items)
                }
                guard current == "," else { throw fail("expecting ',' or ']'") }
                at += 1
                skipSpace()
            }
        }

        mutating func string() throws -> String {
            at += 1
            var out = String.UnicodeScalarView()
            while true {
                guard let c = current else { throw fail("unterminated string") }
                at += 1
                if c == "\"" { return String(out) }
                if c.value < 0x20 { throw fail("control character in string") }
                guard c == "\\" else {
                    out.append(c)
                    continue
                }
                guard let e = current else { throw fail("unterminated escape") }
                at += 1
                switch e {
                case "\"": out.append("\"")
                case "\\": out.append("\\")
                case "/": out.append("/")
                case "b": out.append("\u{08}")
                case "f": out.append("\u{0C}")
                case "n": out.append("\n")
                case "r": out.append("\r")
                case "t": out.append("\t")
                case "u":
                    var code = try hex4()
                    if (0xD800...0xDBFF).contains(code) {
                        guard consume("\\u") else { throw fail("lone surrogate") }
                        let low = try hex4()
                        guard (0xDC00...0xDFFF).contains(low) else { throw fail("lone surrogate") }
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                    }
                    guard let scalar = Unicode.Scalar(code) else { throw fail("lone surrogate") }
                    out.append(scalar)
                default:
                    throw fail("invalid escape")
                }
            }
        }

        mutating func hex4() throws -> UInt32 {
            guard at + 4 <= scalars.count else { throw fail("short \\u escape") }
            var code: UInt32 = 0
            for c in scalars[at..<at + 4] {
                guard let digit = Self.hexDigit(c) else { throw fail("invalid \\u escape") }
                code = code * 16 + digit
            }
            at += 4
            return code
        }

        static func hexDigit(_ c: Unicode.Scalar) -> UInt32? {
            switch c.value {
            case 0x30...0x39: return c.value - 0x30
            case 0x41...0x46: return c.value - 0x41 + 10
            case 0x61...0x66: return c.value - 0x61 + 10
            default: return nil
            }
        }

        /// `-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?`, read as an integer unless it has a
        /// fraction or an exponent.
        mutating func number() throws -> OrderedJSON? {
            let start = at
            var i = at
            func isDigit(_ k: Int) -> Bool {
                k < scalars.count && (0x30...0x39).contains(scalars[k].value)
            }
            if i < scalars.count, scalars[i] == "-" { i += 1 }
            guard isDigit(i) else { return nil }
            if scalars[i] == "0" {
                i += 1
            } else {
                while isDigit(i) { i += 1 }
            }
            var isFloat = false
            if i < scalars.count, scalars[i] == ".", isDigit(i + 1) {
                isFloat = true
                i += 1
                while isDigit(i) { i += 1 }
            }
            if i < scalars.count, scalars[i] == "e" || scalars[i] == "E" {
                var j = i + 1
                if j < scalars.count, scalars[j] == "+" || scalars[j] == "-" { j += 1 }
                if isDigit(j) {
                    isFloat = true
                    i = j
                    while isDigit(i) { i += 1 }
                }
            }
            let literal = String(String.UnicodeScalarView(scalars[start..<i]))
            at = i
            if !isFloat { return .integer(literal) }
            guard let value = Double(literal) else { throw fail("unreadable number") }
            return .float(value)
        }
    }

    // MARK: Writing

    /// `json.dumps(value, indent=2, ensure_ascii=asciiOnly, sort_keys=sortKeys)`.
    func pythonDump(asciiOnly: Bool, sortKeys: Bool) -> String {
        var out = ""
        write(into: &out, level: 0, asciiOnly: asciiOnly, sortKeys: sortKeys)
        return out
    }

    private func write(into out: inout String, level: Int, asciiOnly: Bool, sortKeys: Bool) {
        switch self {
        case .null: out += "null"
        case .bool(let flag): out += flag ? "true" : "false"
        case .integer(let digits): out += Self.normalizedInteger(digits)
        case .float(let value): out += Self.pythonRepr(value)
        case .string(let text): Self.writeString(text, into: &out, asciiOnly: asciiOnly)
        case .array(let items):
            guard !items.isEmpty else {
                out += "[]"
                return
            }
            let inner = "\n" + String(repeating: "  ", count: level + 1)
            out += "["
            for (n, item) in items.enumerated() {
                out += n == 0 ? inner : "," + inner
                item.write(into: &out, level: level + 1, asciiOnly: asciiOnly, sortKeys: sortKeys)
            }
            out += "\n" + String(repeating: "  ", count: level) + "]"
        case .object(let members):
            guard !members.isEmpty else {
                out += "{}"
                return
            }
            let ordered = sortKeys
                ? members.sorted { $0.key.unicodeScalars.lexicographicallyPrecedes($1.key.unicodeScalars) { $0.value < $1.value } }
                : members
            let inner = "\n" + String(repeating: "  ", count: level + 1)
            out += "{"
            for (n, member) in ordered.enumerated() {
                out += n == 0 ? inner : "," + inner
                Self.writeString(member.key, into: &out, asciiOnly: asciiOnly)
                out += ": "
                member.value.write(into: &out, level: level + 1, asciiOnly: asciiOnly, sortKeys: sortKeys)
            }
            out += "\n" + String(repeating: "  ", count: level) + "}"
        }
    }

    private static func writeString(_ text: String, into out: inout String, asciiOnly: Bool) {
        func hex4(_ v: UInt32) -> String {
            let digits = String(v, radix: 16)
            return "\\u" + String(repeating: "0", count: 4 - digits.count) + digits
        }
        out += "\""
        for c in text.unicodeScalars {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if c.value < 0x20 {
                    out += hex4(c.value)
                } else if !asciiOnly || (0x20...0x7E).contains(c.value) {
                    out.unicodeScalars.append(c)
                } else if c.value < 0x10000 {
                    out += hex4(c.value)
                } else {
                    let v = c.value - 0x10000
                    out += hex4(0xD800 + (v >> 10)) + hex4(0xDC00 + (v & 0x3FF))
                }
            }
        }
        out += "\""
    }

    /// Python's `repr(float)`. Both languages print the shortest digits that read back to the
    /// same double, but they lay them out differently: Python switches to an exponent below
    /// 1e-4 and from 1e16 up, and always shows a fractional part otherwise.
    static func pythonRepr(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        let swift = "\(value.magnitude)"
        let parts = swift.split(separator: "e", maxSplits: 1)
        let exponent = parts.count == 2 ? Int(parts[1])! : 0
        let mantissa = parts[0].split(separator: ".", maxSplits: 1)
        let whole = String(mantissa[0])
        var digits = Array(whole + (mantissa.count == 2 ? String(mantissa[1]) : ""))
        // Where the decimal point falls, counted from the first digit.
        var point = whole.count + exponent
        while digits.count > 1, digits.first == "0" {
            digits.removeFirst()
            point -= 1
        }
        while digits.count > 1, digits.last == "0" { digits.removeLast() }
        if digits == ["0"] { point = 1 }

        let sign = value.sign == .minus ? "-" : ""
        let d = String(digits)
        if point <= -4 || point > 16 {
            let e = point - 1
            let body = digits.count > 1 ? "\(digits[0]).\(String(digits.dropFirst()))" : d
            let magnitude = String(abs(e))
            return sign + body + "e" + (e < 0 ? "-" : "+")
                + (magnitude.count < 2 ? "0" + magnitude : magnitude)
        }
        if point <= 0 {
            return sign + "0." + String(repeating: "0", count: -point) + d
        }
        if point < digits.count {
            return sign + String(digits[..<point]) + "." + String(digits[point...])
        }
        return sign + d + String(repeating: "0", count: point - digits.count) + ".0"
    }
}
