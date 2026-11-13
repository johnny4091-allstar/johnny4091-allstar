import Foundation
import WebKit

/// Serves the Aurora screens that are bundled in the app (the same files the Android app and the website use) to the web
/// view at aurora://app/..., so the pages work with no internet and keep their own storage.
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "aurora"
    static let startURL = URL(string: "aurora://app/index.html")!

    private let root: URL? = Bundle.main.url(forResource: "aurora", withExtension: nil)

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg",
        "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "ico": "image/x-icon",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf",
        "mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "video/mp4", "txt": "text/plain; charset=utf-8", "md": "text/plain; charset=utf-8",
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let request = urlSchemeTask.request
        guard let url = request.url, let root = root else { return fail(urlSchemeTask, 404) }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        // Never leave the bundled folder.
        let file = root.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path),
              let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return fail(urlSchemeTask, 404) }

        let type = AssetSchemeHandler.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        var headers = [
            "Content-Type": type,
            "Cache-Control": "no-cache",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
        ]
        var status = 200
        var body = data
        // Sounds and video are asked for in pieces (Range), and Safari refuses to play them otherwise.
        if let range = request.value(forHTTPHeaderField: "Range"), let (from, to) = AssetSchemeHandler.parse(range: range, size: data.count) {
            body = data.subdata(in: from..<(to + 1))
            status = 206
            headers["Content-Range"] = "bytes \(from)-\(to)/\(data.count)"
        }
        headers["Content-Length"] = String(body.count)
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return fail(urlSchemeTask, 500)
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, _ status: Int) {
        if let url = task.request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil) {
            task.didReceive(response)
            task.didFinish()
        } else {
            task.didFailWithError(URLError(.fileDoesNotExist))
        }
    }

    /// "bytes=100-" or "bytes=100-199" for a file of `size` bytes.
    private static func parse(range: String, size: Int) -> (Int, Int)? {
        guard size > 0, range.hasPrefix("bytes=") else { return nil }
        let parts = range.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, let from = Int(parts[0]), from >= 0, from < size else { return nil }
        let to = Int(parts[1]).map { min($0, size - 1) } ?? (size - 1)
        return to >= from ? (from, to) : nil
    }
}
