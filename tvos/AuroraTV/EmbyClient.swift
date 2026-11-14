import Foundation

// MARK: - What the server sends

struct ItemsResponse: Decodable {
    let items: [Item]
    let total: Int?
    enum CodingKeys: String, CodingKey { case items = "Items", total = "TotalRecordCount" }
}

struct UserData: Decodable, Hashable {
    let positionTicks: Int64?
    let playedPercentage: Double?
    let played: Bool?
    enum CodingKeys: String, CodingKey { case positionTicks = "PlaybackPositionTicks", playedPercentage = "PlayedPercentage", played = "Played" }
}

struct Item: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let type: String
    let year: Int?
    let overview: String?
    let runTimeTicks: Int64?
    let seriesName: String?
    let seriesId: String?
    let seasonName: String?
    let indexNumber: Int?
    let parentIndexNumber: Int?
    let rating: String?
    let communityRating: Double?
    let imageTags: [String: String]?
    let backdropTags: [String]?
    let userData: UserData?

    enum CodingKeys: String, CodingKey {
        case id = "Id", name = "Name", type = "Type", year = "ProductionYear", overview = "Overview", runTimeTicks = "RunTimeTicks"
        case seriesName = "SeriesName", seriesId = "SeriesId", seasonName = "SeasonName", indexNumber = "IndexNumber"
        case parentIndexNumber = "ParentIndexNumber", rating = "OfficialRating", communityRating = "CommunityRating"
        case imageTags = "ImageTags", backdropTags = "BackdropImageTags", userData = "UserData"
    }

    var isEpisode: Bool { type == "Episode" }
    var isSeries: Bool { type == "Series" }
    /// "S2 E5" style label for an episode.
    var episodeLabel: String {
        guard isEpisode else { return "" }
        let s = parentIndexNumber.map { "S\($0)" } ?? ""
        let e = indexNumber.map { "E\($0)" } ?? ""
        return [s, e].filter { !$0.isEmpty }.joined(separator: " ")
    }
    /// How far through it the viewer is, 0 to 1 (0 if not started or finished).
    var progress: Double {
        let p = (userData?.playedPercentage ?? 0) / 100
        return p > 0.01 && p < 0.97 ? p : 0
    }
    var resumeTicks: Int64 { progress > 0 ? (userData?.positionTicks ?? 0) : 0 }
    var minutes: Int? { runTimeTicks.map { Int($0 / 600_000_000) } }
}

struct PlaybackSource {
    let url: URL
    let mediaSourceId: String
    let playSessionId: String
    let method: String // DirectPlay or Transcode
}

enum EmbyError: LocalizedError {
    case badAddress, signInFailed, server(Int), noPlayableSource, other(String)
    var errorDescription: String? {
        switch self {
        case .badAddress: return "That server address doesn't look right."
        case .signInFailed: return "That username or password isn't right."
        case .server(let code): return "The server answered \(code)."
        case .noPlayableSource: return "This video can't be played on Apple TV right now."
        case .other(let text): return text
        }
    }
}

// MARK: - The connection

/// Talks to the Emby server. The same requests the Aurora phone and TV apps make, so Aurora Guard sees this device like any other
/// (it shows up as "Aurora" on "Apple TV" in the server's list of devices).
final class EmbyClient {
    let server: String      // like https://example.com:8920 (no trailing slash)
    let token: String
    let userId: String
    let deviceId: String

    init(server: String, token: String, userId: String, deviceId: String) {
        self.server = server
        self.token = token
        self.userId = userId
        self.deviceId = deviceId
    }

    static func normalize(_ text: String) -> String? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard URL(string: s)?.host != nil else { return nil }
        return s
    }

    static func authHeader(deviceId: String, token: String?) -> String {
        var h = "MediaBrowser Client=\"Aurora\", Device=\"Apple TV\", DeviceId=\"\(deviceId)\", Version=\"2.0.0\""
        if let token = token { h += ", Token=\"\(token)\"" }
        return h
    }

    /// Signs in; returns the access token, the user's id and name.
    static func signIn(server: String, username: String, password: String, deviceId: String) async throws -> (token: String, userId: String, name: String) {
        guard let url = URL(string: server + "/emby/Users/AuthenticateByName") else { throw EmbyError.badAddress }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(authHeader(deviceId: deviceId, token: nil), forHTTPHeaderField: "X-Emby-Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["Username": username, "Pw": password])
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 || status == 400 || status == 403 || status == 404 { throw EmbyError.signInFailed }
        guard status == 200,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["AccessToken"] as? String,
              let user = json["User"] as? [String: Any], let id = user["Id"] as? String else { throw EmbyError.server(status) }
        return (token, id, (user["Name"] as? String) ?? username)
    }

    // MARK: Requests

    private func request(_ path: String, query: [String: String] = [:], method: String = "GET", body: Any? = nil) async throws -> Data {
        var components = URLComponents(string: server + "/emby" + path)
        if !query.isEmpty { components?.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = components?.url else { throw EmbyError.badAddress }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "X-Emby-Token")
        request.setValue(EmbyClient.authHeader(deviceId: deviceId, token: token), forHTTPHeaderField: "X-Emby-Authorization")
        if let body = body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw EmbyError.signInFailed }
        guard (200..<300).contains(status) else { throw EmbyError.server(status) }
        return data
    }

    private func items(_ path: String, _ query: [String: String]) async throws -> ItemsResponse {
        let data = try await request(path, query: query)
        return try JSONDecoder().decode(ItemsResponse.self, from: data)
    }

    private static let fields = "Overview,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,SeriesName,SeriesId,SeasonName"

    func resume() async throws -> [Item] {
        try await items("/Users/\(userId)/Items/Resume", ["Limit": "20", "MediaTypes": "Video", "Recursive": "true", "Fields": Self.fields]).items
    }

    func nextUp() async throws -> [Item] {
        try await items("/Shows/NextUp", ["UserId": userId, "Limit": "20", "Fields": Self.fields]).items
    }

    func recent(type: String, limit: Int = 24) async throws -> [Item] {
        try await items("/Users/\(userId)/Items", ["IncludeItemTypes": type, "Recursive": "true", "SortBy": "DateCreated", "SortOrder": "Descending",
                                                   "Limit": String(limit), "Fields": Self.fields]).items
    }

    func library(type: String, start: Int, limit: Int, sort: String) async throws -> ItemsResponse {
        let order = sort == "DateCreated" || sort == "CommunityRating" ? "Descending" : "Ascending"
        return try await items("/Users/\(userId)/Items", ["IncludeItemTypes": type, "Recursive": "true", "SortBy": sort + ",SortName", "SortOrder": order,
                                                           "StartIndex": String(start), "Limit": String(limit), "Fields": Self.fields])
    }

    func seasons(of seriesId: String) async throws -> [Item] {
        try await items("/Shows/\(seriesId)/Seasons", ["UserId": userId, "Fields": "Overview"]).items
    }

    func episodes(of seriesId: String, seasonId: String) async throws -> [Item] {
        try await items("/Shows/\(seriesId)/Episodes", ["UserId": userId, "SeasonId": seasonId, "Fields": "Overview,RunTimeTicks"]).items
    }

    // MARK: Pictures

    func imageURL(_ id: String, type: String = "Primary", tag: String? = nil, height: Int = 480) -> URL? {
        var components = URLComponents(string: server + "/emby/Items/\(id)/Images/\(type)")
        var query = [URLQueryItem(name: "maxHeight", value: String(height)), URLQueryItem(name: "quality", value: "85")]
        if let tag = tag { query.append(URLQueryItem(name: "tag", value: tag)) }
        components?.queryItems = query
        return components?.url
    }

    // MARK: Playback

    /// What Apple TV plays as it is: MP4-family files with H.264 or HEVC video. Everything else is sent by the server as HLS.
    private func deviceProfile() -> [String: Any] {
        [
            "Name": "Aurora Apple TV",
            "MaxStreamingBitrate": 120_000_000,
            "MaxStaticBitrate": 120_000_000,
            "DirectPlayProfiles": [
                ["Container": "mp4,m4v,mov", "Type": "Video", "VideoCodec": "h264,hevc", "AudioCodec": "aac,ac3,eac3,mp3,alac,flac"],
            ],
            "TranscodingProfiles": [
                ["Container": "ts", "Type": "Video", "VideoCodec": "h264,hevc", "AudioCodec": "aac,ac3,eac3", "Protocol": "hls",
                 "Context": "Streaming", "MaxAudioChannels": "6", "MinSegments": "1", "BreakOnNonKeyFrames": true],
            ],
            "CodecProfiles": [
                ["Type": "Video", "Codec": "h264", "Conditions": [["Condition": "LessThanEqual", "Property": "VideoLevel", "Value": "52", "IsRequired": false]]],
            ],
            "SubtitleProfiles": [
                ["Format": "vtt", "Method": "External"], ["Format": "srt", "Method": "External"],
                ["Format": "ass", "Method": "Encode"], ["Format": "ssa", "Method": "Encode"],
                ["Format": "pgssub", "Method": "Encode"], ["Format": "dvdsub", "Method": "Encode"], ["Format": "dvbsub", "Method": "Encode"],
            ],
        ]
    }

    func playbackSource(for item: Item, startTicks: Int64) async throws -> PlaybackSource {
        let data = try await request("/Items/\(item.id)/PlaybackInfo", query: ["UserId": userId, "StartTimeTicks": String(startTicks), "IsPlayback": "true",
                                                                               "AutoOpenLiveStream": "true", "MaxStreamingBitrate": "120000000"],
                                     method: "POST", body: ["DeviceProfile": deviceProfile()])
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sources = json["MediaSources"] as? [[String: Any]], let source = sources.first,
              let sourceId = source["Id"] as? String else { throw EmbyError.noPlayableSource }
        let session = (json["PlaySessionId"] as? String) ?? UUID().uuidString
        func absolute(_ path: String) -> URL? {
            var text = path.hasPrefix("http") ? path : (path.hasPrefix("/emby") ? server + path : server + "/emby" + (path.hasPrefix("/") ? path : "/" + path))
            if !text.contains("api_key=") { text += (text.contains("?") ? "&" : "?") + "api_key=" + token }
            return URL(string: text)
        }
        if (source["SupportsDirectPlay"] as? Bool) == true {
            var components = URLComponents(string: server + "/emby/Videos/\(item.id)/stream")
            components?.queryItems = [URLQueryItem(name: "Static", value: "true"), URLQueryItem(name: "MediaSourceId", value: sourceId),
                                      URLQueryItem(name: "api_key", value: token), URLQueryItem(name: "DeviceId", value: deviceId),
                                      URLQueryItem(name: "PlaySessionId", value: session)]
            if let url = components?.url { return PlaybackSource(url: url, mediaSourceId: sourceId, playSessionId: session, method: "DirectPlay") }
        }
        if let transcoding = source["TranscodingUrl"] as? String, let url = absolute(transcoding) {
            return PlaybackSource(url: url, mediaSourceId: sourceId, playSessionId: session, method: "Transcode")
        }
        throw EmbyError.noPlayableSource
    }

    // MARK: Telling the server what is playing (so Continue Watching is right, and Aurora Guard sees the device)

    func report(_ stage: String, item: Item, source: PlaybackSource, ticks: Int64, paused: Bool = false) async {
        let path = stage == "start" ? "/Sessions/Playing" : stage == "stop" ? "/Sessions/Playing/Stopped" : "/Sessions/Playing/Progress"
        var body: [String: Any] = ["ItemId": item.id, "MediaSourceId": source.mediaSourceId, "PlaySessionId": source.playSessionId,
                                   "PlayMethod": source.method, "PositionTicks": ticks, "CanSeek": true]
        if stage != "stop" { body["IsPaused"] = paused }
        _ = try? await request(path, method: "POST", body: body)
    }
}
