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
          var epg = null;
          var epgKey = function (s) { return String(s || '').trim().toLowerCase(); };
          var epgNormal = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
          var epgFind = function (r) {
            if (!epg) return null;
            var e = r.id ? epg.byId.get(epgKey(r.id)) : null;
            if (!e && r.name) { var k = epg.byName.get(epgNormal(r.name)); if (k) e = epg.byId.get(k); }
            return e || null;
          };
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
            },
            // The TV guide: the app reads it (EpgStore) and hands it over a few hundred channels at a time; lookups are then
            // answered here, the same way the Android app's guide reader answers them.
            loadEpg: function (id, url, ua) {
              post({ cmd: 'epgload', url: url, ua: ua || '' }).then(function (sum) {
                if (!sum || sum.error) { window.auroraEpgDone(id, { error: (sum && sum.error) || 'The guide could not be loaded.' }); return; }
                var byId = new Map(), byName = new Map();
                var next = function (offset) {
                  return post({ cmd: 'epgchunk', token: sum.token, offset: offset }).then(function (rows) {
                    if (!rows || !rows.length) return;
                    rows.forEach(function (r) {
                      byId.set(r[0], [r[1], r[2], r[3]]);
                      var n = epgNormal(r[1]);
                      if (n && !byName.has(n)) byName.set(n, r[0]);
                    });
                    return next(offset + rows.length);
                  });
                };
                return next(0).then(function () {
                  epg = { url: url, byId: byId, byName: byName };
                  window.auroraEpgDone(id, { channels: sum.channels, programmes: sum.programmes });
                });
              }).catch(function () { window.auroraEpgDone(id, { error: 'The guide could not be loaded.' }); });
            },
            epgLookup: function (url, request) {
              var list = [];
              try { list = JSON.parse(request); } catch (e) { /* none */ }
              if (!epg || (url && epg.url !== url)) return 'null';
              return JSON.stringify(list.map(function (r) { var e = epgFind(r); return e ? { n: e[0], i: e[1], p: e[2] } : null; }));
            },
            epgCount: function (url, request) {
              var list = [], listings = 0, logos = 0;
              try { list = JSON.parse(request); } catch (e) { /* none */ }
              if (epg && (!url || epg.url === url)) list.forEach(function (r) { var e = epgFind(r); if (!e) return; if (e[2].length) listings++; if (e[1]) logos++; });
              return JSON.stringify({ listings: listings, logos: logos });
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
        case "epgload":
            guard let url = body["url"] as? String else { return replyHandler(["error": "No guide address."], nil) }
            let agent = (body["ua"] as? String) ?? ""
            Task {
                do {
                    let loaded = try await EpgStore.shared.load(url: url, userAgent: agent)
                    replyHandler(["token": loaded.token, "channels": loaded.channels, "programmes": loaded.programmes], nil)
                } catch {
                    replyHandler(["error": error.localizedDescription], nil)
                }
            }
        case "epgchunk":
            let token = (body["token"] as? String) ?? ""
            let offset = (body["offset"] as? Int) ?? 0
            replyHandler(EpgStore.shared.chunk(token: token, offset: offset), nil)
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
