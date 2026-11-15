import Foundation

/// Tells the Emby server which live channel (M3U / Xtream) this iPhone is playing, so the admin can see it in Aurora's Admin pages.
/// These streams come straight from the TV provider, so Emby wouldn't know otherwise. It is the same thing the Android app's
/// LiveReporter does, written the same way, so Admin reads both alike.
///
/// It is kept in the viewer's own Emby display preferences ("aurora-watching", client "aurora"):
/// {"devices": {deviceId: {name, num, logo, group, now, device, started, at}}, "history": [{name, num, group, device, started, ended}]}
/// The entry is refreshed every minute while playing and removed when the player closes; Admin treats an entry not refreshed for
/// three minutes as stopped.
final class LiveReporter {
    private static let prefsId = "aurora-watching"
    private static let historyMax = 30

    private let base: String, apiKey: String, userId: String, deviceId: String, device: String, auth: String
    /// One thing at a time, off the main thread: nothing here may ever slow the player down.
    private let queue = DispatchQueue(label: "aurora.live-reporter", qos: .utility)
    private var current: [String: Any]?   // what's playing (touched on the queue only)
    private var pending: [String: Any]?   // the channel just started, until the first save has gone through
    private var started: Int64 = 0
    private var closed = false

    /// From the page's report details; nil if there are none (then nothing is reported).
    init?(json: String) {
        guard !json.isEmpty, let data = json.data(using: .utf8),
              let r = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let base = (r["base"] as? String) ?? "", userId = (r["userId"] as? String) ?? "", deviceId = (r["deviceId"] as? String) ?? ""
        if base.isEmpty || userId.isEmpty || deviceId.isEmpty { return nil }
        self.base = base
        self.userId = userId
        self.deviceId = deviceId
        apiKey = (r["apiKey"] as? String) ?? ""
        device = (r["device"] as? String) ?? "iPhone"
        auth = (r["auth"] as? String) ?? ""
    }

    /// A channel started (or the viewer switched to it).
    func playing(name: String, num: String, logo: String, group: String, now: String) {
        let at = Self.nowMs()
        queue.async {
            guard !self.closed else { return }
            let entry: [String: Any] = ["name": name, "num": num, "logo": logo, "group": group, "now": now, "device": self.device]
            self.started = at
            self.pending = entry // so the heartbeat can still send it if this first save fails
            try? self.write(entry, newChannel: true, now: at)
        }
    }

    /// Still watching: refreshes the entry so Admin knows it's live.
    func heartbeat() {
        queue.async {
            guard !self.closed, let entry = self.current ?? self.pending else { return }
            try? self.write(entry, newChannel: false, now: Self.nowMs())
        }
    }

    /// The player closed: remove this device's entry and add the last channel to the history. Anything already queued goes first.
    func stopped() {
        queue.async {
            self.pending = nil
            try? self.write(nil, newChannel: false, now: Self.nowMs())
            self.closed = true
        }
    }

    // MARK: - Saving

    private static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private static func int(_ v: Any?) -> Int64 { (v as? NSNumber)?.int64Value ?? 0 }

    /// Two devices on one account share this one setting and each saves the whole thing, so they can overwrite each other's entry when
    /// both save in the same moment. So after saving, look again: if this device's entry is missing (or, when closing, still there)
    /// save once more after a short random wait. Up to 3 tries.
    private func write(_ entry: [String: Any]?, newChannel: Bool, now: Int64) throws {
        for attempt in 0..<3 {
            let saved = try writeOnce(entry, newChannel: attempt == 0 && newChannel, now: attempt == 0 ? now : Self.nowMs())
            if verify(saved) { return }
            Thread.sleep(forTimeInterval: 0.2 + Double.random(in: 0...0.6))
        }
    }

    /// Is this device's entry in the saved setting as it should be? (A failed read counts as fine: nothing to compare.)
    private func verify(_ entry: [String: Any]?) -> Bool {
        guard let prefs = try? read() else { return true }
        let data = Self.config(prefs)
        let mine = (data["devices"] as? [String: Any])?[deviceId] as? [String: Any]
        guard let entry = entry else { return mine == nil }
        return mine != nil && Self.int(mine?["at"]) == Self.int(entry["at"])
    }

    private static func config(_ prefs: [String: Any]) -> [String: Any] {
        guard let custom = prefs["CustomPrefs"] as? [String: Any], let text = custom["config"] as? String, let d = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return obj
    }

    /// Returns the entry as saved (with its start and refresh times), or nil when it was removed.
    private func writeOnce(_ entry: [String: Any]?, newChannel: Bool, now: Int64) throws -> [String: Any]? {
        let prefs = try read()
        var custom = (prefs["CustomPrefs"] as? [String: Any]) ?? [:]
        var data = Self.config(prefs)
        var devices = (data["devices"] as? [String: Any]) ?? [:]
        var history = (data["history"] as? [[String: Any]]) ?? []

        // What was playing before ends now (a new channel, or the player closing).
        if (newChannel || entry == nil), let cur = current, now - started >= 60_000 { // channel surfing (under a minute) isn't remembered
            let done: [String: Any] = ["name": cur["name"] ?? "", "num": cur["num"] ?? "", "group": cur["group"] ?? "", "device": device, "started": started, "ended": now]
            history = [done] + history.prefix(Self.historyMax - 1)
        }
        var saved: [String: Any]?
        if let entry = entry {
            if newChannel { started = now }
            var e = entry
            e["started"] = started
            e["at"] = now
            current = e
            saved = e
            devices[deviceId] = e
        } else {
            devices[deviceId] = nil
            current = nil
        }
        // Tidy away devices that stopped reporting long ago.
        for (key, value) in devices {
            guard let d = value as? [String: Any], now - Self.int(d["at"]) <= 12 * 3_600_000 else { devices[key] = nil; continue }
        }
        data["devices"] = devices
        data["history"] = history
        guard let configData = try? JSONSerialization.data(withJSONObject: data), let configText = String(data: configData, encoding: .utf8) else { return saved }
        custom["config"] = configText
        let body: [String: Any] = [
            "Id": Self.prefsId, "Client": "aurora", "SortBy": "SortName", "SortOrder": "Ascending", "RememberIndexing": false,
            "RememberSorting": false, "ScrollDirection": "Horizontal", "ShowBackdrop": false, "ShowSidebar": false,
            "PrimaryImageHeight": 0, "PrimaryImageWidth": 0, "CustomPrefs": custom,
        ]
        _ = try request("POST", try JSONSerialization.data(withJSONObject: body))
        return saved
    }

    private func read() throws -> [String: Any] {
        let data = try request("GET", nil)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    /// A plain request that waits for the answer. It runs on this class's own background queue, never the main thread.
    private func request(_ method: String, _ body: Data?) throws -> Data {
        guard var parts = URLComponents(string: base + "/DisplayPreferences/" + Self.prefsId) else { throw URLError(.badURL) }
        parts.queryItems = [URLQueryItem(name: "userId", value: userId), URLQueryItem(name: "client", value: "aurora"), URLQueryItem(name: "api_key", value: apiKey)]
        guard let url = parts.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !auth.isEmpty { request.setValue(auth, forHTTPHeaderField: "X-Emby-Authorization") }
        if let body = body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        final class Box { var data: Data?; var response: URLResponse?; var error: Error? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            box.data = data; box.response = response; box.error = error
            done.signal()
        }.resume()
        done.wait()
        if let error = box.error { throw error }
        if let http = box.response as? HTTPURLResponse, http.statusCode >= 400 { throw URLError(.badServerResponse) }
        return box.data ?? Data()
    }
}
