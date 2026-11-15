import Foundation
import Security

/// A tiny keychain helper: the sign-in token lives in the Apple TV's keychain, not in plain settings.
enum Keychain {
    private static let service = "com.johnny4091.aurora.tv"

    static func set(_ value: String, for key: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func remove(_ key: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(query as CFDictionary)
    }
}

/// Who is signed in, and what is playing.
@MainActor
final class Session: ObservableObject {
    static let defaultServer = "https://emby4836.duckdns.org:8920"

    @Published private(set) var client: EmbyClient?
    @Published private(set) var userName = ""
    @Published var playing: Item?

    let deviceId: String
    private let defaults = UserDefaults.standard

    var lastServer: String { defaults.string(forKey: "server") ?? Session.defaultServer }

    init() {
        if let id = defaults.string(forKey: "deviceId") {
            deviceId = id
        } else {
            deviceId = "aurora-tv-" + UUID().uuidString
            defaults.set(deviceId, forKey: "deviceId")
        }
        if let server = defaults.string(forKey: "server"), let token = Keychain.get("token"), let user = defaults.string(forKey: "userId") {
            client = EmbyClient(server: server, token: token, userId: user, deviceId: deviceId)
            userName = defaults.string(forKey: "userName") ?? ""
        }
    }

    func signIn(server: String, username: String, password: String) async throws {
        guard let address = EmbyClient.normalize(server) else { throw EmbyError.badAddress }
        let result = try await EmbyClient.signIn(server: address, username: username, password: password, deviceId: deviceId)
        defaults.set(address, forKey: "server")
        defaults.set(result.userId, forKey: "userId")
        defaults.set(result.name, forKey: "userName")
        Keychain.set(result.token, for: "token")
        userName = result.name
        client = EmbyClient(server: address, token: result.token, userId: result.userId, deviceId: deviceId)
    }

    func signOut() {
        if let client = client {
            Task { _ = try? await URLSession.shared.data(for: signOutRequest(client)) }
        }
        Keychain.remove("token")
        defaults.removeObject(forKey: "userId")
        defaults.removeObject(forKey: "userName")
        playing = nil
        client = nil
        userName = ""
    }

    private func signOutRequest(_ client: EmbyClient) -> URLRequest {
        var request = URLRequest(url: URL(string: client.server + "/emby/Sessions/Logout")!)
        request.httpMethod = "POST"
        request.setValue(client.token, forHTTPHeaderField: "X-Emby-Token")
        return request
    }
}
