import AVFoundation
import AVKit
import SwiftUI

/// Runs one playback: asks the server how to play it, starts Apple's player, and tells the server where the viewer is (so "Continue
/// Watching" is right, and Aurora Guard sees this device).
@MainActor
final class PlayerModel: ObservableObject {
    @Published var player: AVPlayer?
    @Published var error: String?

    private var client: EmbyClient?
    private var item: Item?
    private var source: PlaybackSource?
    private var startTicks: Int64 = 0
    private var observer: Any?
    private var stopped = false

    func start(item: Item, client: EmbyClient?) async {
        guard let client = client else { error = "You're not signed in."; return }
        self.client = client
        self.item = item
        startTicks = item.resumeTicks
        do {
            let source = try await client.playbackSource(for: item, startTicks: startTicks)
            if stopped { return }
            self.source = source
            let options: [String: Any] = ["AVURLAssetHTTPHeaderFieldsKey": ["X-Emby-Token": client.token]]
            let asset = AVURLAsset(url: source.url, options: options)
            let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
            // A converted (HLS) stream already starts at the resume point; a file played as it is needs a jump.
            if source.method == "DirectPlay", startTicks > 0 {
                _ = await player.seek(to: CMTime(seconds: Double(startTicks) / 10_000_000, preferredTimescale: 600))
            }
            self.player = player
            player.play()
            await client.report("start", item: item, source: source, ticks: startTicks)
            observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 10, preferredTimescale: 1), queue: .main) { [weak self] _ in
                guard let self = self else { return }
                Task { @MainActor in await self.progress() }
            }
        } catch {
            self.error = (error as? EmbyError)?.errorDescription ?? "This video couldn't be started. Check your connection and try again."
        }
    }

    private func position() -> Int64 {
        guard let player = player else { return startTicks }
        let seconds = player.currentTime().seconds
        guard seconds.isFinite else { return startTicks }
        let offset: Int64 = source?.method == "Transcode" ? startTicks : 0
        return offset + Int64(seconds * 10_000_000)
    }

    private func progress() async {
        guard let client = client, let item = item, let source = source, !stopped else { return }
        await client.report("progress", item: item, source: source, ticks: position(), paused: (player?.rate ?? 0) == 0)
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        let ticks = position()
        if let observer = observer { player?.removeTimeObserver(observer) }
        observer = nil
        player?.pause()
        let client = self.client, item = self.item, source = self.source
        player = nil
        if let client = client, let item = item, let source = source {
            Task { await client.report("stop", item: item, source: source, ticks: ticks) }
        }
    }
}

struct PlayerScreen: View {
    @EnvironmentObject var session: Session
    let item: Item
    @StateObject private var model = PlayerModel()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let player = model.player {
                VideoPlayer(player: player).ignoresSafeArea()
            } else if let error = model.error {
                VStack(spacing: 30) {
                    Text(error).multilineTextAlignment(.center).padding(.horizontal, 80)
                    Button("Close") { session.playing = nil }
                }
            } else {
                VStack(spacing: 20) {
                    ProgressView()
                    Text(item.isEpisode ? (item.seriesName ?? item.name) : item.name).foregroundColor(.secondary)
                }
            }
        }
        .task { await model.start(item: item, client: session.client) }
        .onDisappear { model.stop() }
    }
}
