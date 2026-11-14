import Compression
import Foundation

/// The XMLTV guide, read by the app rather than the web page (the same job EpgLoader does in the Android app). A provider's
/// guide can be tens of megabytes, plain or gzipped. The app downloads it once, reads it as a stream, keeps the next few hours
/// of every channel, and hands that to the page in small pieces (see Bridge.swift).
struct EpgError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class EpgStore {
    static let shared = EpgStore()

    /// How long a downloaded guide file is reused, and how long a read guide is used without fetching a newer one.
    private let downloadSeconds: TimeInterval = 6 * 3600
    private let freshSeconds: TimeInterval = 4 * 3600
    /// The guide page shows six hours; keep a little before now and ten hours ahead.
    private let beforeMs: Int64 = 3_600_000
    private let aheadMs: Int64 = 10 * 3_600_000
    private let maxPerChannel = 30
    private let maxProgrammes = 300_000
    private let maxDesc = 120

    struct Guide {
        let token: String
        let builtAt: Date
        /// One row per channel: [key, name, icon, [[start, end, title, desc], ...]]
        let rows: [[Any]]
        let programmes: Int
    }

    private let lock = NSLock()
    private var guides: [String: Guide] = [:]
    private var loading: [String: Task<Guide, Error>] = [:]

    // MARK: - For the page

    func load(url text: String, userAgent: String) async throws -> (token: String, channels: Int, programmes: Int) {
        guard let url = URL(string: text), ["http", "https"].contains(url.scheme ?? "") else {
            throw EpgError(message: "The guide address isn't a web address.")
        }
        let token = Self.hash(text)
        lock.lock()
        if let g = guides[token], Date().timeIntervalSince(g.builtAt) < freshSeconds {
            lock.unlock()
            return (token, g.rows.count, g.programmes)
        }
        let running = loading[token]
        lock.unlock()
        if let running = running {
            let g = try await running.value
            return (token, g.rows.count, g.programmes)
        }
        let task = Task<Guide, Error> { try await self.build(url: url, token: token, userAgent: userAgent) }
        lock.lock(); loading[token] = task; lock.unlock()
        do {
            let g = try await task.value
            lock.lock()
            loading[token] = nil
            guides[token] = g
            // Keep this guide and at most one other (the admin's "test this source" reads a different one).
            if guides.count > 2, let oldest = guides.values.filter({ $0.token != token }).min(by: { $0.builtAt < $1.builtAt }) { guides[oldest.token] = nil }
            lock.unlock()
            return (token, g.rows.count, g.programmes)
        } catch {
            lock.lock(); loading[token] = nil; lock.unlock()
            // A guide read earlier is still better than none.
            lock.lock(); let old = guides[token]; lock.unlock()
            if let old = old { return (token, old.rows.count, old.programmes) }
            throw error
        }
    }

    /// The next channels of a loaded guide, `count` at a time from `offset`. Empty when there are no more.
    func chunk(token: String, offset: Int, count: Int = 400) -> [[Any]] {
        lock.lock(); let g = guides[token]; lock.unlock()
        guard let rows = g?.rows, offset < rows.count else { return [] }
        return Array(rows[offset..<min(rows.count, offset + count)])
    }

    // MARK: - Reading the guide

    private func build(url: URL, token: String, userAgent: String) async throws -> Guide {
        let file = try await download(url: url, token: token, userAgent: userAgent)
        let xml = try prepare(file)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let parser = EpgParser(from: now - beforeMs, to: now + aheadMs, maxPerChannel: maxPerChannel, maxProgrammes: maxProgrammes, maxDesc: maxDesc)
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let stream = InputStream(url: xml) else { return done.resume(throwing: EpgError(message: "The guide file couldn't be read.")) }
                let xmlParser = XMLParser(stream: stream)
                xmlParser.shouldProcessNamespaces = false
                xmlParser.delegate = parser
                _ = xmlParser.parse()
                // A guide cut off part way is still used for what was read.
                if parser.channels.isEmpty && parser.progs.isEmpty {
                    let why = xmlParser.parserError?.localizedDescription ?? "it had no channels"
                    done.resume(throwing: EpgError(message: "The guide couldn't be read (\(why))."))
                } else {
                    done.resume()
                }
            }
        }
        var keys = Set(parser.channels.keys)
        keys.formUnion(parser.progs.keys)
        var rows: [[Any]] = []
        rows.reserveCapacity(keys.count)
        for key in keys {
            let ch = parser.channels[key]
            let list = (parser.progs[key] ?? []).sorted { $0.start < $1.start }
            rows.append([key, ch?.name ?? "", ch?.icon ?? "", list.map { [$0.start, $0.end, $0.title, $0.desc] as [Any] }])
        }
        return Guide(token: token, builtAt: Date(), rows: rows, programmes: parser.count)
    }

    // MARK: - Files

    private func cacheDir() throws -> URL {
        let base = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("epg", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Guides nobody has used in a couple of days (old links, earlier versions) are cleared out.
        let cutoff = Date().addingTimeInterval(-48 * 3600)
        for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let d = try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, d < cutoff { try? FileManager.default.removeItem(at: f) }
        }
        return dir
    }

    /// Downloads the guide to the cache, reusing a copy less than six hours old. A stale copy is used if the download fails.
    private func download(url: URL, token: String, userAgent: String) async throws -> URL {
        let file = try cacheDir().appendingPathComponent(token + ".dl")
        let fm = FileManager.default
        func age() -> TimeInterval? {
            guard let d = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                  let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 else { return nil }
            return Date().timeIntervalSince(d)
        }
        if let a = age(), a < downloadSeconds { return file }
        var request = URLRequest(url: url)
        request.timeoutInterval = 90
        if !userAgent.isEmpty { request.setValue(userAgent, forHTTPHeaderField: "User-Agent") }
        do {
            let (tmp, response) = try await URLSession.shared.download(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                throw EpgError(message: "The guide address answered \(http.statusCode).")
            }
            let size = (try? tmp.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if size < 20 { throw EpgError(message: "The guide address sent back an empty guide.") }
            // A web page instead of a guide (the provider's error or "too many connections" page, often sent with status 200)
            // must not replace the last good guide.
            let probe = try prepare(tmp, keepSource: true)
            if let why = notAGuide(probe) {
                try? fm.removeItem(at: tmp)
                if probe != tmp { try? fm.removeItem(at: probe) }
                throw EpgError(message: why)
            }
            if probe != tmp { try? fm.removeItem(at: probe) }
            try? fm.removeItem(at: file)
            try fm.moveItem(at: tmp, to: file)
            return file
        } catch {
            if age() != nil { return file }
            throw error
        }
    }

    /// The plain XML for a downloaded file: itself, or a decompressed copy next to it when it is gzipped.
    private func prepare(_ file: URL, keepSource: Bool = false) throws -> URL {
        guard let handle = try? FileHandle(forReadingFrom: file) else { throw EpgError(message: "The guide file couldn't be read.") }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 2)) ?? Data()
        guard head.count == 2, head[0] == 0x1f, head[1] == 0x8b else { return file }
        let out = file.deletingPathExtension().appendingPathExtension(keepSource ? "probe.xml" : "xml")
        try Self.gunzip(from: file, to: out)
        return out
    }

    /// nil if the file looks like an XMLTV guide; otherwise what it is instead.
    private func notAGuide(_ file: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return "The guide file couldn't be read." }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: 4096)) ?? Data()
        let start = (String(data: data, encoding: .utf8) ?? "").replacingOccurrences(of: "\u{FEFF}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = start.lowercased()
        if lower.hasPrefix("<?xml") || lower.hasPrefix("<tv") || lower.hasPrefix("<!doctype tv") || lower.hasPrefix("<!--") { return nil }
        let page = lower.hasPrefix("<!doctype html") || lower.hasPrefix("<html") || lower.contains("<body")
        return (page ? "The TV provider sent a web page instead of the guide" : "The guide address didn't send a TV guide")
            + ". The provider may be blocking this internet connection, or the account may be busy or expired."
    }

    // MARK: - gzip

    /// Unzips a .gz file by skipping its header and inflating the rest as a stream (so a big guide is never all in memory).
    static func gunzip(from source: URL, to destination: URL) throws {
        let fm = FileManager.default
        try? fm.removeItem(at: destination)
        guard fm.createFile(atPath: destination.path, contents: nil), let input = try? FileHandle(forReadingFrom: source),
              let output = try? FileHandle(forWritingTo: destination) else { throw EpgError(message: "The guide file couldn't be unpacked.") }
        defer { try? input.close(); try? output.close() }

        // The gzip header: 10 bytes, then optional extra data, a name, a comment and a checksum.
        guard var first = try input.read(upToCount: 65536), first.count > 10 else { throw EpgError(message: "The guide file couldn't be unpacked.") }
        let flags = first[3]
        var pos = 10
        func skipZeroTerminated() { while pos < first.count, first[pos] != 0 { pos += 1 }; pos += 1 }
        if flags & 4 != 0, pos + 2 <= first.count { pos += 2 + Int(first[pos]) + Int(first[pos + 1]) << 8 }
        if flags & 8 != 0 { skipZeroTerminated() }
        if flags & 16 != 0 { skipZeroTerminated() }
        if flags & 2 != 0 { pos += 2 }
        guard pos <= first.count else { throw EpgError(message: "The guide file couldn't be unpacked.") }
        first = first.subdata(in: pos..<first.count)

        let dummy = UnsafeMutablePointer<UInt8>.allocate(capacity: 1)
        defer { dummy.deallocate() }
        var stream = compression_stream(dst_ptr: dummy, dst_size: 0, src_ptr: UnsafePointer(dummy), src_size: 0, state: nil)
        guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw EpgError(message: "The guide file couldn't be unpacked.")
        }
        defer { compression_stream_destroy(&stream) }

        let capacity = 262_144
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        defer { buffer.deallocate() }

        var pending: Data? = first
        var finished = false
        while !finished {
            let chunk: Data
            if let p = pending { chunk = p; pending = nil } else { chunk = (try input.read(upToCount: 65536)) ?? Data() }
            let atEnd = chunk.isEmpty
            var failure = false
            chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                stream.src_ptr = raw.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(dummy)
                stream.src_size = chunk.count
                while true {
                    stream.dst_ptr = buffer
                    stream.dst_size = capacity
                    let flag: Int32 = atEnd ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
                    let status = compression_stream_process(&stream, flag)
                    let produced = capacity - stream.dst_size
                    if produced > 0 { try? output.write(contentsOf: Data(bytes: buffer, count: produced)) }
                    if status == COMPRESSION_STATUS_ERROR { failure = true; return }
                    if status == COMPRESSION_STATUS_END { finished = true; return }
                    if stream.src_size == 0 && stream.dst_size > 0 { return }
                }
            }
            if failure { throw EpgError(message: "The guide file couldn't be unpacked.") }
            if atEnd { break }
        }
    }

    private static func hash(_ s: String) -> String {
        var h: UInt64 = 5381
        for b in s.utf8 { h = (h &* 33) &+ UInt64(b) }
        return String(h, radix: 16)
    }
}

/// Reads XMLTV: channels (id, name, logo) and the programmes inside the time window.
final class EpgParser: NSObject, XMLParserDelegate {
    struct Programme { let start: Int64; let end: Int64; let title: String; let desc: String }

    private(set) var channels: [String: (name: String, icon: String)] = [:]
    private(set) var progs: [String: [Programme]] = [:]
    private(set) var count = 0

    private let from: Int64, to: Int64, maxPerChannel: Int, maxProgrammes: Int, maxDesc: Int

    private enum Target { case none, name, title, desc }
    private var target = Target.none
    private var buffer = ""
    private var chId: String?, chName: String?, chIcon: String?
    private var inProg = false
    private var progCh = "", start: Int64 = 0, stop: Int64 = 0
    private var title: String?, desc: String?

    init(from: Int64, to: Int64, maxPerChannel: Int, maxProgrammes: Int, maxDesc: Int) {
        self.from = from; self.to = to; self.maxPerChannel = maxPerChannel; self.maxProgrammes = maxProgrammes; self.maxDesc = maxDesc
    }

    private func key(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces).lowercased() }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes attr: [String: String]) {
        switch name {
        case "channel":
            chId = attr["id"]; chName = nil; chIcon = nil
        case "display-name":
            if chId != nil, chName == nil { target = .name; buffer = "" }
        case "icon":
            if chId != nil, chIcon == nil { chIcon = attr["src"] }
        case "programme":
            progCh = attr["channel"] ?? ""
            start = Self.time(attr["start"]); stop = Self.time(attr["stop"])
            title = nil; desc = nil
            inProg = !progCh.isEmpty && stop > from && start < to && stop > start
        case "title":
            if inProg, title == nil { target = .title; buffer = "" }
        case "desc":
            if inProg, desc == nil { target = .desc; buffer = "" }
        default:
            break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if target != .none { buffer += string }
    }

    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
        if target != .none, let s = String(data: CDATABlock, encoding: .utf8) { buffer += s }
    }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        switch name {
        case "display-name":
            if target == .name { chName = buffer.trimmingCharacters(in: .whitespacesAndNewlines) }
            target = .none
        case "title":
            if target == .title { title = buffer.trimmingCharacters(in: .whitespacesAndNewlines) }
            target = .none
        case "desc":
            if target == .desc {
                var d = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
                if d.count > maxDesc { d = String(d.prefix(maxDesc - 1)) + "\u{2026}" }
                desc = d
            }
            target = .none
        case "channel":
            if let id = chId { channels[key(id)] = (chName ?? "", chIcon ?? "") }
            chId = nil
        case "programme":
            if inProg, let t = title, count < maxProgrammes {
                let k = key(progCh)
                if (progs[k]?.count ?? 0) < maxPerChannel {
                    progs[k, default: []].append(Programme(start: start, end: stop, title: t, desc: desc ?? ""))
                    count += 1
                }
            }
            inProg = false
        default:
            break
        }
    }

    /// XMLTV times look like "20240101203000 +0100"; the offset is optional (then UTC). Milliseconds since 1970, or 0.
    static func time(_ s: String?) -> Int64 {
        guard let s = s else { return 0 }
        let u = Array(s.utf8)
        guard u.count >= 14 else { return 0 }
        func num(_ a: Int, _ b: Int) -> Int? {
            var v = 0
            for i in a..<b { let c = Int(u[i]) - 48; if c < 0 || c > 9 { return nil }; v = v * 10 + c }
            return v
        }
        guard let y = num(0, 4), let mo = num(4, 6), let d = num(6, 8), let h = num(8, 10), let mi = num(10, 12), let se = num(12, 14),
              mo >= 1, mo <= 12 else { return 0 }
        var offsetSeconds = 0
        var i = 14
        while i < u.count, u[i] == 32 { i += 1 }
        if i + 5 <= u.count, u[i] == 43 || u[i] == 45, let oh = num(i + 1, i + 3), let om = num(i + 3, i + 5) {
            offsetSeconds = (oh * 3600 + om * 60) * (u[i] == 45 ? -1 : 1)
        }
        // Days since 1970 for a calendar date.
        let yy = mo <= 2 ? y - 1 : y
        let era = (yy >= 0 ? yy : yy - 399) / 400
        let yoe = yy - era * 400
        let doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        let days = era * 146_097 + doe - 719_468
        return Int64(days * 86_400 + h * 3600 + mi * 60 + se - offsetSeconds) * 1000
    }
}
