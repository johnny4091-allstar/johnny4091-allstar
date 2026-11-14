import AVFoundation
import UIKit

/// One channel handed over by the page.
struct LiveChannel {
    let name: String
    let url: String
    let number: String
    let now: String

    init(_ json: [String: Any]) {
        url = (json["url"] as? String) ?? ""
        name = (json["name"] as? String) ?? "Channel"
        number = (json["num"] as? String) ?? ""
        now = (json["now"] as? String) ?? ""
    }
}

/// Full-screen live TV: Apple's player, with swipe up and down to change channel, a channel list, and a quiet retry when the provider
/// hiccups. The iPhone plays HLS streams: a provider's raw ".ts" stream address is asked for as ".m3u8" instead (the usual way a
/// provider offers both).
final class LivePlayerViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let channels: [LiveChannel]
    private var index: Int
    private let groupName: String
    private let userAgent: String
    private let onClose: (Int, [String: Any]) -> Void

    private let player = AVPlayer()
    private var playerLayer = AVPlayerLayer()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let topBar = UIView()
    private let bottomBar = UIView()
    private let numberLabel = UILabel()
    private let titleLabel = UILabel()
    private let nowLabel = UILabel()
    private let statusLabel = UILabel()

    private var hideTimer: Timer?
    private var retryWork: DispatchWorkItem?
    private var retries = 0
    private var itemObservation: NSKeyValueObservation?
    private var rateObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var visited: [Int] = []
    private var failures = 0
    private var lastFailedName = ""
    private var closed = false

    init(channels: [LiveChannel], index: Int, group: String, userAgent: String, onClose: @escaping (Int, [String: Any]) -> Void) {
        self.channels = channels
        self.index = max(0, min(index, channels.count - 1))
        self.groupName = group
        self.userAgent = userAgent
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: Setup

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        playerLayer = AVPlayerLayer(player: player)
        playerLayer.videoGravity = .resizeAspect
        view.layer.addSublayer(playerLayer)

        spinner.color = .white
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)

        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.isHidden = true
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)

        // Top: close button and the channel.
        topBar.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)
        let close = button(title: "\u{2715}", action: #selector(closeTapped))
        numberLabel.textColor = UIColor(red: 0.16, green: 0.83, blue: 0.82, alpha: 1)
        numberLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .bold)
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 18, weight: .bold)
        nowLabel.textColor = UIColor(white: 0.85, alpha: 1)
        nowLabel.font = .systemFont(ofSize: 14)
        let text = UIStackView(arrangedSubviews: [numberLabel, titleLabel, nowLabel])
        text.axis = .vertical
        text.spacing = 1
        let topRow = UIStackView(arrangedSubviews: [close, text])
        topRow.spacing = 12
        topRow.alignment = .center
        topRow.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(topRow)

        // Bottom: previous, list, next.
        bottomBar.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bottomBar)
        let prev = button(title: "\u{25C0}\u{FE0E}  Channel", action: #selector(previousTapped))
        let list = button(title: "Channels", action: #selector(listTapped))
        let next = button(title: "Channel  \u{25B6}\u{FE0E}", action: #selector(nextTapped))
        let bottomRow = UIStackView(arrangedSubviews: [prev, list, next])
        bottomRow.distribution = .equalSpacing
        bottomRow.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.addSubview(bottomRow)

        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 56),
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: safe.trailingAnchor, constant: -24),
            topBar.topAnchor.constraint(equalTo: view.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topRow.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),
            topRow.bottomAnchor.constraint(equalTo: topBar.bottomAnchor, constant: -10),
            topRow.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            topRow.trailingAnchor.constraint(lessThanOrEqualTo: safe.trailingAnchor, constant: -12),
            bottomBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomRow.topAnchor.constraint(equalTo: bottomBar.topAnchor, constant: 10),
            bottomRow.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -8),
            bottomRow.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
            bottomRow.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
        ])

        // Tap shows or hides the controls; swipe up goes to the next channel, down to the previous.
        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleBars))
        view.addGestureRecognizer(tap)
        for direction in [UISwipeGestureRecognizer.Direction.up, .down] {
            let swipe = UISwipeGestureRecognizer(target: self, action: #selector(swiped(_:)))
            swipe.direction = direction
            view.addGestureRecognizer(swipe)
        }

        // Sound plays even with the silent switch on, and the screen stays awake.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        UIApplication.shared.isIdleTimerDisabled = true

        rateObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            DispatchQueue.main.async { self?.playbackStateChanged(player.timeControlStatus) }
        }
        play(index: index)
        showBars(autoHide: true)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        playerLayer.frame = view.bounds
    }

    private func button(title: String, action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.setTitleColor(.white, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        b.contentEdgeInsets = UIEdgeInsets(top: 8, left: 14, bottom: 8, right: 14)
        b.backgroundColor = UIColor(white: 1, alpha: 0.16)
        b.layer.cornerRadius = 10
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    // MARK: Channels

    /// The address to play: an Xtream provider's /live/.../123.ts is asked for as .m3u8 (HLS), which the iPhone plays.
    static func playableURL(_ text: String) -> URL? {
        var address = text
        if let regex = try? NSRegularExpression(pattern: "^(.*/live/.+)\\.ts((?:\\?.*)?)$", options: [.caseInsensitive]) {
            let range = NSRange(address.startIndex..., in: address)
            address = regex.stringByReplacingMatches(in: address, options: [], range: range, withTemplate: "$1.m3u8$2")
        }
        return URL(string: address)
    }

    private func play(index newIndex: Int) {
        guard channels.indices.contains(newIndex) else { return }
        retryWork?.cancel()
        retries = 0
        index = newIndex
        if visited.last != newIndex { visited.append(newIndex) }
        let channel = channels[newIndex]
        numberLabel.text = channel.number.isEmpty ? (groupName.isEmpty ? "" : groupName.uppercased()) : channel.number
        titleLabel.text = channel.name
        nowLabel.text = channel.now
        statusLabel.isHidden = true
        start(channel)
    }

    private func start(_ channel: LiveChannel) {
        guard let url = LivePlayerViewController.playableURL(channel.url) else { return fail(channel, "This channel's address isn't valid.") }
        spinner.startAnimating()
        var options: [String: Any] = [:]
        if !userAgent.isEmpty { options["AVURLAssetHTTPHeaderFieldsKey"] = ["User-Agent": userAgent] }
        let asset = AVURLAsset(url: url, options: options.isEmpty ? nil : options)
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 6
        itemObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self, item === self.player.currentItem else { return }
                if item.status == .failed { self.itemFailed(channel, item.error) }
            }
        }
        if let old = endObserver { NotificationCenter.default.removeObserver(old) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] note in
            self?.itemFailed(channel, note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)
        }
        player.replaceCurrentItem(with: item)
        player.play()
    }

    private func itemFailed(_ channel: LiveChannel, _ error: Error?) {
        guard !closed, channels.indices.contains(index), channels[index].url == channel.url else { return }
        // A provider often fails once and works a moment later: try again a few times before saying so.
        if retries < 3 {
            retries += 1
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, !self.closed, self.channels.indices.contains(self.index), self.channels[self.index].url == channel.url else { return }
                self.start(channel)
            }
            retryWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: work)
            return
        }
        let isTS = channel.url.lowercased().contains(".ts") && LivePlayerViewController.playableURL(channel.url)?.absoluteString == channel.url
        fail(channel, isTS
            ? "This channel is sent in a format the iPhone can't play. Ask the person who runs your service to turn on the HLS (m3u8) format."
            : "This channel isn't working right now. It may be busy, or your account may be in use on another device.")
    }

    private func fail(_ channel: LiveChannel, _ message: String) {
        spinner.stopAnimating()
        failures += 1
        lastFailedName = channel.name
        statusLabel.text = message
        statusLabel.isHidden = false
        showBars(autoHide: false)
    }

    private func playbackStateChanged(_ status: AVPlayer.TimeControlStatus) {
        switch status {
        case .playing:
            spinner.stopAnimating()
            statusLabel.isHidden = true
            retries = 0
            showBars(autoHide: true)
        case .waitingToPlayAtSpecifiedRate:
            if statusLabel.isHidden { spinner.startAnimating() }
        default:
            break
        }
    }

    // MARK: Controls

    @objc private func toggleBars() {
        if topBar.alpha < 0.5 { showBars(autoHide: true) } else { hideBars() }
    }

    private func showBars(autoHide: Bool) {
        UIView.animate(withDuration: 0.2) { self.topBar.alpha = 1; self.bottomBar.alpha = 1 }
        hideTimer?.invalidate()
        if autoHide {
            hideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.hideBars() }
        }
    }

    private func hideBars() {
        hideTimer?.invalidate()
        if !statusLabel.isHidden { return } // a message stays up with its controls
        UIView.animate(withDuration: 0.3) { self.topBar.alpha = 0; self.bottomBar.alpha = 0 }
    }

    @objc private func swiped(_ gesture: UISwipeGestureRecognizer) {
        gesture.direction == .up ? nextTapped() : previousTapped()
    }

    @objc private func nextTapped() { play(index: (index + 1) % channels.count); showBars(autoHide: true) }
    @objc private func previousTapped() { play(index: (index - 1 + channels.count) % channels.count); showBars(autoHide: true) }

    @objc private func listTapped() {
        hideTimer?.invalidate()
        let table = UITableViewController(style: .plain)
        table.title = groupName.isEmpty ? "Channels" : groupName
        table.tableView.dataSource = self
        table.tableView.delegate = self
        table.tableView.register(UITableViewCell.self, forCellReuseIdentifier: "channel")
        table.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(listDone))
        let navigation = UINavigationController(rootViewController: table)
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
        }
        present(navigation, animated: true) {
            table.tableView.scrollToRow(at: IndexPath(row: self.index, section: 0), at: .middle, animated: false)
        }
    }

    @objc private func listDone() { dismiss(animated: true) { self.showBars(autoHide: true) } }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { channels.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "channel", for: indexPath)
        let channel = channels[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.text = [channel.number, channel.name].filter { !$0.isEmpty }.joined(separator: "  ")
        content.secondaryText = channel.now.isEmpty ? nil : channel.now
        cell.contentConfiguration = content
        cell.accessoryType = indexPath.row == index ? .checkmark : .none
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        dismiss(animated: true) {
            self.play(index: indexPath.row)
            self.showBars(autoHide: true)
        }
    }

    // MARK: Closing

    @objc private func closeTapped() { finish() }

    private func finish() {
        guard !closed else { return }
        closed = true
        hideTimer?.invalidate()
        retryWork?.cancel()
        itemObservation = nil
        rateObservation = nil
        if let old = endObserver { NotificationCenter.default.removeObserver(old) }
        player.pause()
        player.replaceCurrentItem(with: nil)
        UIApplication.shared.isIdleTimerDisabled = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        let stats: [String: Any] = ["visited": Array(visited.dropLast()), "failed": failures, "failedName": lastFailedName]
        let ended = index
        dismiss(animated: true) { self.onClose(ended, stats) }
    }
}
