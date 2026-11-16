import SwiftUI

extension Color {
    static let auroraBackground = Color(red: 7 / 255, green: 12 / 255, blue: 28 / 255)
    static let auroraAccent = Color(red: 42 / 255, green: 212 / 255, blue: 208 / 255)
}

@main
struct AuroraTVApp: App {
    @StateObject private var session = Session()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .preferredColorScheme(.dark)
        }
    }
}

/// Sign-in screen until someone is signed in, then the app. Playing a title covers everything.
struct RootView: View {
    @EnvironmentObject var session: Session

    var body: some View {
        ZStack {
            Color.auroraBackground.ignoresSafeArea()
            if session.client == nil {
                SignInView()
            } else {
                MainTabs()
            }
        }
        .fullScreenCover(item: $session.playing) { item in
            PlayerScreen(item: item)
                .environmentObject(session)
        }
    }
}

struct MainTabs: View {
    @EnvironmentObject var session: Session

    var body: some View {
        TabView {
            HomeView().tabItem { Text("Home") }
            LibraryView(type: "Movie", title: "Movies").tabItem { Text("Movies") }
            LibraryView(type: "Series", title: "TV Shows").tabItem { Text("TV Shows") }
            LiveTVView().tabItem { Text("Live TV") }
            SettingsView().tabItem { Text("Settings") }
        }
    }
}

/// A text box that is clearly a box: a soft fill when it is not selected, and a bright outline when it is.
private struct FieldBox: ViewModifier {
    let focused: Bool
    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .padding(.horizontal, 28)
            .padding(.vertical, 20)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(focused ? 0.28 : 0.14)))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.auroraAccent, lineWidth: focused ? 4 : 0))
    }
}

struct SignInView: View {
    @EnvironmentObject var session: Session
    private enum Field: Hashable { case server, username, password }
    @FocusState private var focus: Field?
    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var showServer = false
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        VStack(spacing: 28) {
            Text("AURORA")
                .font(.system(size: 64, weight: .light))
                .tracking(14)
            Text("Sign in with your Aurora username and password")
                .font(.title3)
                .foregroundColor(.secondary)
            VStack(spacing: 18) {
                // The server is already filled in. Customers never need to see it; "Use a different server" is for the rare exception.
                if showServer {
                    TextField("Server address", text: $server)
                        .textContentType(.URL)
                        .focused($focus, equals: .server)
                        .modifier(FieldBox(focused: focus == .server))
                }
                TextField("Username", text: $username)
                    .textContentType(.username)
                    .focused($focus, equals: .username)
                    .modifier(FieldBox(focused: focus == .username))
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .modifier(FieldBox(focused: focus == .password))
            }
            .frame(maxWidth: 800)
            if let message = message {
                Text(message).foregroundColor(.red).multilineTextAlignment(.center)
            }
            Button {
                Task { await signIn() }
            } label: {
                if busy { ProgressView() } else { Text("Sign in").frame(minWidth: 240) }
            }
            .disabled(busy || username.isEmpty)
            if !showServer {
                Button("Use a different server") { showServer = true }
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
        .padding(60)
        .onAppear {
            if server.isEmpty { server = session.lastServer }
            if focus == nil { focus = .username }
        }
    }

    private func signIn() async {
        busy = true
        message = nil
        do {
            try await session.signIn(server: server, username: username, password: password)
        } catch {
            message = (error as? EmbyError)?.errorDescription ?? "Couldn't reach the server. Check your internet and try again."
        }
        busy = false
    }
}

struct SettingsView: View {
    @EnvironmentObject var session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Settings").font(.largeTitle).bold()
            Text("Signed in as \(session.userName)")
            if let server = session.client?.server { Text("Server: \(server)").foregroundColor(.secondary) }
            Text("Aurora for Apple TV \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") (\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""))")
                .foregroundColor(.secondary)
            Button("Sign out") { session.signOut() }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(80)
    }
}
