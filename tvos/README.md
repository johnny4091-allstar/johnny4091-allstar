# Aurora for Apple TV

A native Apple TV app (SwiftUI). Apple TV has no web view, so it can't reuse the Aurora web screens the iPhone app shows: it is built
from scratch and talks straight to your Emby server, the same way the Aurora phone and TV apps do. Aurora Guard sees it like any other
device ("Aurora" on "Apple TV"): device limits, plans and end dates apply.

## What works in this version (stage 1: Movies and TV)

- Sign in with the server address, username and password. (The address is filled in with the last one used, and can be changed.)
- Home: Continue Watching, Next Up, Recently Added Movies and TV Shows.
- Movies and TV Shows: grids with sorting (A to Z, Recently Added, Top Rated) and paging.
- A movie or show page: the story, Play or Resume (and Start over), and for a show its seasons and episodes.
- Playback with Apple's player and the Siri Remote. A file Apple TV can play as it is (MP4 family, H.264 or HEVC) is played directly; anything
  else is sent by the server as HLS. The server is told where you are, so Continue Watching is right on every device.
- Settings: who is signed in, the server, and Sign out.

Not yet: search, Favorites, subtitle and audio choices, Live TV and the guide, Requests, the provider's titles, Admin.

## How it is built

`project.yml` describes the project. `xcodegen generate` (in this folder) makes `AuroraTV.xcodeproj`, which is not committed. GitHub builds
it on a Mac with `.github/workflows/aurora-tvos.yml`: it compiles for the Apple TV simulator, and with the Apple secrets
(see `../ios/README.md`) it signs the app and sends it to TestFlight too. It uses the same bundle ID as the iPhone app, so both are one
app in App Store Connect.

## Setting up the Apple TV app in App Store Connect (once)

1. App Store Connect → Apps → Aurora Media → the **+** next to the app name (or the platform list) → **tvOS**. It uses the same bundle ID.
2. Push, or run the workflow by hand. The build appears under TestFlight → **tvOS builds** after Apple has processed it.
3. Add testers (individual testers or a group) to the tvOS build, as for the iPhone. Testers install **TestFlight** from the Apple TV's
   App Store and accept the invite.

Nothing here can be run on an Apple TV until it comes through TestFlight.
