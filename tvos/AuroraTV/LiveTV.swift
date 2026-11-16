import AVFoundation
import AVKit
import SwiftUI

// MARK: - What Live TV is set up with

/// The Live TV settings the admin saved in Aurora (kept on the Emby server, one copy per account), the same ones the phone and website read.
struct LiveSetup {
    var type = ""
    var server = ""
    var username = ""
    var password = ""
    var m3uUrl = ""
    var userAgent = ""
    var catsShown: Set<String>?
    var catsHidden: Set<String>?
    var adultCats: Set<String>?

    var isReady: Bool { (type == "m3u" && !m3uUrl.isEmpty) || (type == "xtream" && !server.isEmpty && !username.isEmpty) }

    init?(json: [String: Any]) {
        type = (json["type"] as? String) ?? ""
        server = (json["server"] as? String) ?? ""
        username = (json["username"] as? String) ?? ""
        password = (json["password"] as? String) ?? ""
        m3uUrl = (json["m3uUrl"] as? String) ?? ""
        userAgent = (json["userAgent"] as? String) ?? ""
        func ids(_ key: String) -> Set<String>? {
            guard let list = json[key] as? [Any] else { return nil }
            return Set(list.map { "\($0)" })
        }
        catsShown = ids("catsShown")
        catsHidden = ids("catsHidden")
        adultCats = ids("adultCats")
        if !isReady { return nil }
    }
}

struct LiveCategory: Identifiable, Hashable {
    let id: String
    let name: String
}

struct LiveChannelItem: Identifiable, Hashable {
    let id: String
    let name: String
    let logo: String
    let number: String
    let url: URL
}

/// Adult categories are never shown in the Apple apps, whatever the account's settings say.
private let adultName = try! NSRegularExpression(pattern: "(adult(?!\\s*swim)|xxx|18\\s*\\+|\\+\\s*18|porn|erotic|nsfw|hentai|playboy|\\bsex\\b|\\bsexy\\b)", options: [.caseInsensitive])

// MARK: - Loading channels

@MainActor
final class LiveModel: ObservableObject {
    @Published var categories: [LiveCategory] = []
    @Published var channels: [LiveChannelItem] = []
    @Published var selected: String?
    @Published var loadingList = true
    @Published var loadingChannels = false
    @Published var message: String?

    private var setup: LiveSetup?
    private var m3uGroups: [String: [LiveChannelItem]] = [:]
    private var cache: [String: [LiveChannelItem]] = [:]
    private var loaded = false
    var userAgent: String { setup?.userAgent ?? "" }

    func load(client: EmbyClient?) async {
        guard !loaded, let client = client else { return }
        loadingList = true
        message = nil
        do {
            guard let cfg = try await client.liveSetup() else {
                message = "Live TV isn't set up on your account yet."
                loadingList = false
                return
            }
            setup = cfg
            categories = try await loadCategories(cfg)
            loaded = true
            if let first = categories.first { await choose(first.id) }
            if categories.isEmpty { message = "There are no channels to show." }
        } catch {
            message = (error as? EmbyError)?.errorDescription ?? "Couldn't load the channels. Check your connection and try again."
        }
        loadingList = false
    }

    func retry(client: EmbyClient?) async {
        loaded = false
        cache.removeAll()
        await load(client: client)
    }

    func choose(_ id: String) async {
        guard let cfg = setup else { return }
        selected = id
        if let hit = cache[id] { channels = hit; return }
        loadingChannels = true
        channels = []
        do {
            let list = try await loadChannels(cfg, category: id)
            cache[id] = list
            if selected == id { channels = list }
        } catch {
            if selected == id { message = (error as? EmbyError)?.errorDescription ?? "Couldn't load that category." }
        }
        loadingChannels = false
    }

    // MARK: The provider

    private func fetch(_ text: String, _ cfg: LiveSetup, timeout: TimeInterval = 60) async throws -> Data {
        guard let url = URL(string: text) else { throw EmbyError.other("The TV provider's address doesn't look right.") }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        if !cfg.userAgent.isEmpty { request.setValue(cfg.userAgent, forHTTPHeaderField: "User-Agent") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw EmbyError.other("The TV provider answered \(status).") }
        return data
    }

    private func base(_ cfg: LiveSetup) -> String {
        var s = cfg.server.trimmingCharacters(in: .whitespaces)
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    private func xtream(_ cfg: LiveSetup, _ action: String, category: String? = nil) async throws -> [[String: Any]] {
        var parts = URLComponents(string: base(cfg) + "/player_api.php")
        var query = [URLQueryItem(name: "username", value: cfg.username), URLQueryItem(name: "password", value: cfg.password), URLQueryItem(name: "action", value: action)]
        if let category = category { query.append(URLQueryItem(name: "category_id", value: category)) }
        parts?.queryItems = query
        guard let address = parts?.url?.absoluteString else { throw EmbyError.other("The TV provider's address doesn't look right.") }
        let data = try await fetch(address, cfg)
        guard let list = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw EmbyError.other("The TV provider didn't accept the account. Ask for help from your provider.")
        }
        return list
    }

    /// Which categories this account may see: the admin's choices, minus anything adult.
    private func allowed(_ cfg: LiveSetup, id: String, name: String) -> Bool {
        if let adult = cfg.adultCats {
            if adult.contains(id) { return false }
        } else if adultName.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil {
            return false
        }
        if let shown = cfg.catsShown { return shown.contains(id) }
        if let hidden = cfg.catsHidden, !hidden.isEmpty { return !hidden.contains(id) }
        return true
    }

    private func loadCategories(_ cfg: LiveSetup) async throws -> [LiveCategory] {
        if cfg.type == "m3u" {
            var address = cfg.m3uUrl.trimmingCharacters(in: .whitespaces)
            if !address.lowercased().hasPrefix("http") { address = "http://" + address }
            let data = try await fetch(address, cfg, timeout: 120)
            let text = String(decoding: data, as: UTF8.self)
            guard text.contains("#EXTM3U") || text.contains("#EXTINF") else { throw EmbyError.other("That address didn't return a channel list.") }
            m3uGroups = parseM3u(text)
            return m3uGroups.keys.sorted().filter { allowed(cfg, id: $0, name: $0) }.map { LiveCategory(id: $0, name: $0) }
        }
        let cats = try await xtream(cfg, "get_live_categories")
        return cats.compactMap { c in
            let id = "\(c["category_id"] ?? "")", name = (c["category_name"] as? String) ?? "Channels"
            return id.isEmpty || !allowed(cfg, id: id, name: name) ? nil : LiveCategory(id: id, name: name)
        }
    }

    private func loadChannels(_ cfg: LiveSetup, category: String) async throws -> [LiveChannelItem] {
        if cfg.type == "m3u" { return m3uGroups[category] ?? [] }
        let list = try await xtream(cfg, "get_live_streams", category: category)
        let user = cfg.username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? cfg.username
        let pass = cfg.password.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? cfg.password
        return list.compactMap { st in
            let sid = "\(st["stream_id"] ?? "")"
            // Apple TV plays HLS, not the provider's raw stream.
            guard !sid.isEmpty, let url = URL(string: "\(base(cfg))/live/\(user)/\(pass)/\(sid).m3u8") else { return nil }
            return LiveChannelItem(id: "x" + sid, name: (st["name"] as? String) ?? "Channel", logo: (st["stream_icon"] as? String) ?? "",
                                   number: st["num"].map { "\($0)" } ?? "", url: url)
        }
    }

    private func parseM3u(_ text: String) -> [String: [LiveChannelItem]] {
        var groups: [String: [LiveChannelItem]] = [:]
        var name = "", logo = "", group = "", number = "", have = false, n = 0
        func attr(_ line: String, _ key: String) -> String {
            guard let r = line.range(of: key + "=\"", options: .caseInsensitive), let end = line[r.upperBound...].firstIndex(of: "\"") else { return "" }
            return String(line[r.upperBound..<end])
        }
        for raw in text.split(whereSeparator: { $0 == "\n" || $0 == "\r\n" || $0 == "\r" }) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#EXTINF") {
                logo = attr(line, "tvg-logo"); group = attr(line, "group-title"); number = attr(line, "tvg-chno")
                var quoted = false, cut: String.Index?
                for i in line.indices {
                    if line[i] == "\"" { quoted.toggle() } else if line[i] == "," && !quoted { cut = i; break }
                }
                name = cut.map { String(line[line.index(after: $0)...]).trimmingCharacters(in: .whitespaces) } ?? ""
                if name.isEmpty { name = attr(line, "tvg-name") }
                have = true
            } else if !line.hasPrefix("#") && !line.isEmpty && have {
                let g = group.isEmpty ? "Channels" : group
                var address = line
                if let r = address.range(of: "^(.*/live/.+)\\.ts((?:\\?.*)?)$", options: [.regularExpression, .caseInsensitive]) {
                    let whole = String(address[r])
                    if let dot = whole.range(of: ".ts", options: [.caseInsensitive, .backwards]) { address = String(whole[..<dot.lowerBound]) + ".m3u8" + String(whole[dot.upperBound...]) }
                }
                if let url = URL(string: address) {
                    n += 1
                    groups[g, default: []].append(LiveChannelItem(id: "m\(n)", name: name.isEmpty ? "Channel" : name, logo: logo, number: number, url: url))
                }
                have = false
            }
        }
        return groups
    }
}

extension EmbyClient {
    /// The Live TV settings saved on this account (nil when there are none).
    func liveSetup() async throws -> LiveSetup? {
        let data = try await request("/DisplayPreferences/aurora-livetv", query: ["userId": userId, "client": "aurora"])
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prefs = json["CustomPrefs"] as? [String: Any], let raw = prefs["config"] as? String, !raw.isEmpty,
              let cfg = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { return nil }
        return LiveSetup(json: cfg)
    }
}

// MARK: - Screens

struct LiveTVView: View {
    @EnvironmentObject var session: Session
    @StateObject private var model = LiveModel()
    @State private var playing: LiveChannelItem?

    private let columns = [GridItem(.adaptive(minimum: 300), spacing: 30)]

    var body: some View {
        HStack(alignment: .top, spacing: 40) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Live TV").font(.largeTitle).bold()
                if model.loadingList {
                    ProgressView().padding(.top, 20)
                } else if model.categories.isEmpty {
                    Text(model.message ?? "No channels.").foregroundColor(.secondary)
                    Button("Try again") { Task { await model.retry(client: session.client) } }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(model.categories) { cat in
                                Button { Task { await model.choose(cat.id) } } label: {
                                    HStack {
                                        Text(cat.name).lineLimit(1)
                                        Spacer()
                                        if model.selected == cat.id { Image(systemName: "checkmark").foregroundColor(.auroraAccent) }
                                    }
                                    .frame(maxWidth: .infinity)
                                }
                            }
                        }
                        .padding(.vertical, 20)
                    }
                }
            }
            .frame(width: 520)
            ScrollView {
                if model.loadingChannels {
                    ProgressView().padding(.top, 80)
                } else if model.channels.isEmpty && !model.loadingList && !model.categories.isEmpty {
                    Text(model.message ?? "There are no channels in this category.").foregroundColor(.secondary).padding(.top, 80)
                } else {
                    LazyVGrid(columns: columns, spacing: 30) {
                        ForEach(model.channels) { channel in
                            Button { playing = channel } label: { ChannelCard(channel: channel) }
                                .buttonStyle(.card)
                        }
                    }
                    .padding(.vertical, 20)
                }
            }
        }
        .padding(.horizontal, 60)
        .task { await model.load(client: session.client) }
        .fullScreenCover(item: $playing) { channel in
            LivePlayerScreen(channels: model.channels, start: channel, userAgent: model.userAgent)
        }
    }
}

struct ChannelCard: View {
    let channel: LiveChannelItem

    var body: some View {
        VStack(spacing: 12) {
            AsyncImage(url: URL(string: channel.logo)) { phase in
                switch phase {
                case .success(let image): image.resizable().scaledToFit()
                default: Image(systemName: "tv").font(.system(size: 50)).foregroundColor(.secondary)
                }
            }
            .frame(height: 110)
            Text(channel.name).font(.callout).lineLimit(2).multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(maxWidth: .infinity, minHeight: 220)
    }
}

/// Plays a channel full screen. Up and down on the remote (or the arrows) change channel; Menu closes it.
struct LivePlayerScreen: View {
    @Environment(\.dismiss) private var dismiss
    let channels: [LiveChannelItem]
    let start: LiveChannelItem
    let userAgent: String
    @State private var index = 0
    @State private var player = AVPlayer()
    @State private var banner = true
    @State private var failed = false

    private var current: LiveChannelItem { channels.indices.contains(index) ? channels[index] : start }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color.black.ignoresSafeArea()
            VideoPlayer(player: player).ignoresSafeArea()
            if banner || failed {
                VStack(alignment: .leading, spacing: 6) {
                    Text(current.number.isEmpty ? current.name : "\(current.number)  \(current.name)").font(.title2).bold()
                    if failed { Text("This channel isn't playing. Press up or down for another one.").font(.callout).foregroundColor(.secondary) }
                }
                .padding(30)
                .background(Color.black.opacity(0.6))
                .cornerRadius(16)
                .padding(60)
            }
        }
        .onAppear {
            index = channels.firstIndex(of: start) ?? 0
            tune()
        }
        .onDisappear { player.pause() }
        .onMoveCommand { direction in
            guard !channels.isEmpty else { return }
            if direction == .up { index = (index + 1) % channels.count; tune() }
            else if direction == .down { index = (index - 1 + channels.count) % channels.count; tune() }
        }
    }

    private func tune() {
        failed = false
        banner = true
        var options: [String: Any] = [:]
        if !userAgent.isEmpty { options["AVURLAssetHTTPHeaderFieldsKey"] = ["User-Agent": userAgent] }
        let asset = AVURLAsset(url: current.url, options: options)
        let item = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: item)
        player.play()
        let shown = current.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if current.id == shown { banner = false } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            if current.id == shown && (player.currentItem?.status == .failed || player.timeControlStatus != .playing) { failed = true }
        }
    }
}
