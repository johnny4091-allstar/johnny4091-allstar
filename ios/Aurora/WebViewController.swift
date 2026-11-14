import UIKit
import WebKit

/// One full-screen web view that shows the Aurora screens bundled in the app.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, LiveHost {
    private let background = UIColor(red: 7 / 255, green: 12 / 255, blue: 28 / 255, alpha: 1)
    private var webView: WKWebView!
    private let handler = BridgeHandler()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }
    override var prefersHomeIndicatorAutoHidden: Bool { false }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = background
        handler.host = self

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AssetSchemeHandler(), forURLScheme: AssetSchemeHandler.scheme)
        config.userContentController.addUserScript(Bridge.userScript())
        config.userContentController.addScriptMessageHandler(handler, contentWorld: .page, name: Bridge.handlerName)
        // Videos play inside the page (and go full screen from its own button), and start when the page asks.
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = background
        web.scrollView.backgroundColor = background
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        // Inside the safe area: clear of the notch and the home bar.
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: guide.topAnchor),
            web.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
        ])
        webView = web
        web.load(URLRequest(url: AssetSchemeHandler.startURL))
    }

    // MARK: Live TV

    /// Opens the live TV player over the page, and tells the page which channel it ended on and what happened.
    func presentLive(channels: [LiveChannel], index: Int, group: String, userAgent: String) {
        guard presentedViewController == nil else { return } // a double tap must not open a second player
        let player = LivePlayerViewController(channels: channels, index: index, group: group, userAgent: userAgent) { [weak self] ended, stats in
            guard let self = self,
                  let data = try? JSONSerialization.data(withJSONObject: stats),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.webView.evaluateJavaScript("window.auroraLiveClosed && window.auroraLiveClosed(\(ended), \(json))", completionHandler: nil)
        }
        present(player, animated: true)
    }

    // MARK: Navigation

    /// Links that leave the app (a website, an App Store page) open in Safari; the Aurora screens stay in the web view.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if url.scheme == AssetSchemeHandler.scheme || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            return decisionHandler(.allow)
        }
        if navigationAction.navigationType == .linkActivated, ["http", "https", "mailto", "tel"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    /// A page that opens a new window (target="_blank") goes to Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        return nil
    }

    /// If iOS closes the web view's process to free memory, start it again rather than showing a blank screen.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: AssetSchemeHandler.startURL))
    }

    // MARK: Page alerts (the pages use confirm() in a few places)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
