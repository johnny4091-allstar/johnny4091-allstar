import Foundation
import UIKit
import WebKit

/// What the Aurora screens can ask the iPhone app to do. The screens already talk to a small native object named
/// window.EmbyFlixAndroid (the Android app provides it). Here the same name is provided for the iPhone, but only for the
/// things this version supports; the screens switch off anything the object doesn't have (updates from GitHub, downloads,
/// the Android player). Calls that need an answer from Swift go through a promise.
enum Bridge {
    static let handlerName = "aurora"

    /// Script that runs before the page starts.
    static func userScript() -> WKUserScript {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = (info["CFBundleShortVersionString"] as? String) ?? "2.0.0"
        let build = (info["CFBundleVersion"] as? String) ?? "1"
        let device = UIDevice.current.model // "iPhone"
        let js = """
        (function () {
          var post = function (m) { return window.webkit.messageHandlers.\(handlerName).postMessage(m); };
          window.AuroraIOS = true;
          window.EmbyFlixAndroid = {
            getVersionName: function () { return \(quote("\(version) (\(build))")); },
            getDeviceName: function () { return \(quote(device)); },
            isTv: function () { return false; },
            showKeyboard: function () {},
            setPlayerMode: function () {},
            openYouTube: function (id) { post({ cmd: 'openurl', url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(id) }); return true; },
            playLive: function (channels, index, group, userAgent, report) {
              post({ cmd: 'playLive', channels: channels, index: index, group: group || '', ua: userAgent || '' });
            },
            httpRequest: function (id, method, url, headers, body) {
              post({ cmd: 'http', method: method, url: url, headers: headers, body: body }).then(
                function (r) { window.auroraHttpDone(id, r); },
                function () { window.auroraHttpDone(id, { status: 0, body: '' }); });
            }
          };
        })();
        """
        return WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// A string as a JavaScript literal.
    private static func quote(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s]), var text = String(data: data, encoding: .utf8) else { return "\"\"" }
        text.removeFirst(); text.removeLast() // the [ and ]
        return text
    }
}

/// What the page's calls can ask of the screen that shows it.
protocol LiveHost: AnyObject {
    func presentLive(channels: [LiveChannel], index: Int, group: String, userAgent: String)
}

/// Receives the page's calls.
final class BridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var host: LiveHost?

    /// Requests the page makes through the app: some services (Jellyseerr) don't allow calls from a web page, and the app
    /// keeps its own cookies for them, like the Android app does.
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return replyHandler(nil, "bad message") }
        switch cmd {
        case "openurl":
            if let text = body["url"] as? String, let url = URL(string: text), url.scheme == "https" {
                DispatchQueue.main.async { UIApplication.shared.open(url) }
            }
            replyHandler(true, nil)
        case "http":
            http(body, reply: replyHandler)
        case "playLive":
            if let text = body["channels"] as? String, let data = text.data(using: .utf8),
               let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], !list.isEmpty {
                let channels = list.map { LiveChannel($0) }
                let index = (body["index"] as? Int) ?? 0
                let group = (body["group"] as? String) ?? ""
                let agent = (body["ua"] as? String) ?? ""
                DispatchQueue.main.async { self.host?.presentLive(channels: channels, index: index, group: group, userAgent: agent) }
            }
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown command")
        }
    }

    private func http(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let text = body["url"] as? String, let url = URL(string: text), ["http", "https"].contains(url.scheme ?? "") else {
            return reply(["status": 0, "body": ""], nil)
        }
        var request = URLRequest(url: url)
        request.httpMethod = (body["method"] as? String) ?? "GET"
        if let raw = body["headers"] as? String, let data = raw.data(using: .utf8),
           let headers = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for (key, value) in headers { request.setValue("\(value)", forHTTPHeaderField: key) }
        }
        if let payload = body["body"] as? String, !payload.isEmpty, request.httpMethod != "GET" { request.httpBody = payload.data(using: .utf8) }
        session.dataTask(with: request) { data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else { return reply(["status": 0, "body": ""], nil) }
            // Cookies set by the service are handed back to the page, which keeps them (the Android app does the same).
            let cookie = (http.allHeaderFields["Set-Cookie"] as? String) ?? ""
            reply(["status": http.statusCode, "body": String(data: data ?? Data(), encoding: .utf8) ?? "", "setCookie": cookie], nil)
        }.resume()
    }
}
