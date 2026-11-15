import SwiftUI

// MARK: - A poster

struct PosterCard: View {
    @EnvironmentObject var session: Session
    let item: Item
    var landscape = false

    private var width: CGFloat { landscape ? 400 : 240 }
    private var height: CGFloat { landscape ? 225 : 360 }

    private var imageURL: URL? {
        guard let client = session.client else { return nil }
        if landscape {
            if item.isEpisode, let tag = item.imageTags?["Primary"] { return client.imageURL(item.id, tag: tag, height: 360) }
            if let tag = item.backdropTags?.first { return client.imageURL(item.id, type: "Backdrop", tag: tag, height: 360) }
        }
        return client.imageURL(item.id, tag: item.imageTags?["Primary"], height: landscape ? 360 : 540)
    }

    private var title: String { item.isEpisode ? (item.seriesName ?? item.name) : item.name }
    private var subtitle: String {
        if item.isEpisode { return [item.episodeLabel, item.name].filter { !$0.isEmpty }.joined(separator: " · ") }
        return item.year.map { String($0) } ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .bottom) {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFill()
                    default:
                        ZStack {
                            Color(white: 0.14)
                            Text(title).font(.callout).multilineTextAlignment(.center).padding(12)
                        }
                    }
                }
                .frame(width: width, height: height)
                .clipped()
                if item.progress > 0 {
                    ProgressView(value: item.progress)
                        .tint(.auroraAccent)
                        .padding(10)
                }
            }
            Text(title).font(.caption).lineLimit(1).frame(width: width, alignment: .leading)
            Text(subtitle).font(.caption2).foregroundColor(.secondary).lineLimit(1).frame(width: width, alignment: .leading)
        }
        .frame(width: width)
    }
}

/// Opens an item: a movie or series shows its page; an episode plays straight away.
struct ItemLink: View {
    @EnvironmentObject var session: Session
    let item: Item
    var landscape = false

    var body: some View {
        if item.isEpisode {
            Button { session.playing = item } label: { PosterCard(item: item, landscape: landscape) }
                .buttonStyle(.card)
        } else {
            NavigationLink(value: item) { PosterCard(item: item, landscape: landscape) }
                .buttonStyle(.card)
        }
    }
}

// MARK: - Home

struct HomeRow: Identifiable {
    let id: String
    let title: String
    let items: [Item]
    let landscape: Bool
}

struct HomeView: View {
    @EnvironmentObject var session: Session
    @State private var rows: [HomeRow] = []
    @State private var loading = true
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 44) {
                    if loading && rows.isEmpty { ProgressView().frame(maxWidth: .infinity).padding(.top, 120) }
                    if let failure = failure, rows.isEmpty {
                        VStack(spacing: 20) {
                            Text(failure).foregroundColor(.secondary)
                            Button("Try again") { Task { await load() } }
                        }
                        .frame(maxWidth: .infinity).padding(.top, 120)
                    }
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 18) {
                            Text(row.title).font(.title3).bold().padding(.leading, 60)
                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(spacing: 40) {
                                    ForEach(row.items) { item in ItemLink(item: item, landscape: row.landscape) }
                                }
                                .padding(.horizontal, 60)
                                .padding(.vertical, 24)
                            }
                        }
                    }
                }
            }
            .navigationDestination(for: Item.self) { DetailView(item: $0) }
        }
        .task { await load() }
    }

    private func load() async {
        guard let client = session.client else { return }
        loading = true
        failure = nil
        async let resume = try? client.resume()
        async let nextUp = try? client.nextUp()
        async let movies = try? client.recent(type: "Movie")
        async let shows = try? client.recent(type: "Series")
        let found: [HomeRow] = [
            HomeRow(id: "resume", title: "Continue Watching", items: (await resume) ?? [], landscape: true),
            HomeRow(id: "next", title: "Next Up", items: (await nextUp) ?? [], landscape: true),
            HomeRow(id: "movies", title: "Recently Added Movies", items: (await movies) ?? [], landscape: false),
            HomeRow(id: "shows", title: "Recently Added TV Shows", items: (await shows) ?? [], landscape: false),
        ].filter { !$0.items.isEmpty }
        rows = found
        if found.isEmpty { failure = "Nothing to show yet, or the server couldn't be reached." }
        loading = false
    }
}

// MARK: - Movies and TV Shows

struct LibraryView: View {
    @EnvironmentObject var session: Session
    let type: String
    let title: String

    @State private var items: [Item] = []
    @State private var total = Int.max
    @State private var sort = "SortName"
    @State private var loading = false
    @State private var failure: String?

    private let columns = [GridItem(.adaptive(minimum: 240, maximum: 260), spacing: 40, alignment: .top)]
    private let page = 60

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Picker("Sort", selection: $sort) {
                        Text("A to Z").tag("SortName")
                        Text("Recently Added").tag("DateCreated")
                        Text("Top Rated").tag("CommunityRating")
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 900)
                    .padding(.horizontal, 60)
                    LazyVGrid(columns: columns, spacing: 50) {
                        ForEach(items) { item in
                            ItemLink(item: item)
                                .onAppear { if item.id == items.last?.id { Task { await loadMore() } } }
                        }
                    }
                    .padding(.horizontal, 60)
                    if loading { ProgressView().frame(maxWidth: .infinity) }
                    if let failure = failure { Text(failure).foregroundColor(.secondary).padding(.horizontal, 60) }
                }
                .padding(.top, 20)
            }
            .navigationDestination(for: Item.self) { DetailView(item: $0) }
        }
        .task { if items.isEmpty { await reload() } }
        .onChange(of: sort) { _ in Task { await reload() } }
    }

    private func reload() async {
        items = []
        total = Int.max
        await loadMore()
    }

    private func loadMore() async {
        guard let client = session.client, !loading, items.count < total else { return }
        loading = true
        failure = nil
        do {
            let result = try await client.library(type: type, start: items.count, limit: page, sort: sort)
            total = result.total ?? items.count + result.items.count
            items += result.items
            if result.items.isEmpty { total = items.count }
        } catch {
            failure = (error as? EmbyError)?.errorDescription ?? "Couldn't reach the server."
        }
        loading = false
    }
}

// MARK: - A movie or a series

struct DetailView: View {
    @EnvironmentObject var session: Session
    let item: Item

    @State private var seasons: [Item] = []
    @State private var seasonId: String?
    @State private var episodes: [Item] = []
    @State private var failure: String?

    private var backdrop: URL? {
        guard let client = session.client, let tag = item.backdropTags?.first else { return nil }
        return client.imageURL(item.id, type: "Backdrop", tag: tag, height: 1080)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                HStack(alignment: .top, spacing: 50) {
                    PosterCard(item: item)
                    VStack(alignment: .leading, spacing: 18) {
                        Text(item.name).font(.largeTitle).bold()
                        Text(meta).foregroundColor(.secondary)
                        if let overview = item.overview, !overview.isEmpty {
                            Text(overview).lineLimit(8)
                        }
                        if !item.isSeries {
                            HStack(spacing: 24) {
                                Button { session.playing = item } label: {
                                    Label(item.resumeTicks > 0 ? "Resume" : "Play", systemImage: "play.fill").padding(.horizontal, 20)
                                }
                                if item.resumeTicks > 0 {
                                    Button { session.playing = restarted(item) } label: { Text("Start over").padding(.horizontal, 20) }
                                }
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                if item.isSeries { seriesBody }
            }
            .padding(60)
        }
        .background(
            AsyncImage(url: backdrop) { phase in
                if case .success(let image) = phase { image.resizable().scaledToFill().opacity(0.22).ignoresSafeArea() }
            }
        )
        .task { if item.isSeries { await loadSeasons() } }
    }

    private var meta: String {
        var parts: [String] = []
        if let year = item.year { parts.append(String(year)) }
        if let rating = item.rating { parts.append(rating) }
        if let minutes = item.minutes, minutes > 0 { parts.append("\(minutes) min") }
        if let score = item.communityRating { parts.append(String(format: "\u{2605} %.1f", score)) }
        return parts.joined(separator: "  ·  ")
    }

    /// The same item without a resume point, so "Start over" starts at 0.
    private func restarted(_ item: Item) -> Item {
        Item(id: item.id, name: item.name, type: item.type, year: item.year, overview: item.overview, runTimeTicks: item.runTimeTicks,
             seriesName: item.seriesName, seriesId: item.seriesId, seasonName: item.seasonName, indexNumber: item.indexNumber,
             parentIndexNumber: item.parentIndexNumber, rating: item.rating, communityRating: item.communityRating,
             imageTags: item.imageTags, backdropTags: item.backdropTags, userData: nil)
    }

    @ViewBuilder private var seriesBody: some View {
        if let failure = failure { Text(failure).foregroundColor(.secondary) }
        if seasons.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 20) {
                    ForEach(seasons) { season in
                        Button { Task { await select(season.id) } } label: {
                            Text(season.name).padding(.horizontal, 14)
                        }
                        .opacity(season.id == seasonId ? 1 : 0.7)
                    }
                }
                .padding(.vertical, 12)
            }
        }
        LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(episodes) { episode in
                Button { session.playing = episode } label: {
                    HStack(alignment: .top, spacing: 24) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text([episode.indexNumber.map { "\($0)." } ?? "", episode.name].filter { !$0.isEmpty }.joined(separator: " ")).font(.headline)
                            if let overview = episode.overview, !overview.isEmpty {
                                Text(overview).font(.caption).foregroundColor(.secondary).lineLimit(3)
                            }
                        }
                        Spacer(minLength: 0)
                        if episode.progress > 0 { ProgressView(value: episode.progress).tint(.auroraAccent).frame(width: 120) }
                        if let minutes = episode.minutes, minutes > 0 { Text("\(minutes) min").font(.caption).foregroundColor(.secondary) }
                    }
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func loadSeasons() async {
        guard let client = session.client else { return }
        do {
            seasons = try await client.seasons(of: item.id)
            if let first = seasons.first { await select(first.id) }
        } catch {
            failure = (error as? EmbyError)?.errorDescription ?? "Couldn't load the seasons."
        }
    }

    private func select(_ id: String) async {
        guard let client = session.client else { return }
        seasonId = id
        do { episodes = try await client.episodes(of: item.id, seasonId: id) }
        catch { failure = (error as? EmbyError)?.errorDescription ?? "Couldn't load the episodes." }
    }
}
