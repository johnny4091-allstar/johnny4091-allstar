# Aurora for Roku

A native Roku channel (BrightScript and SceneGraph). A Roku has no web view, so it can't reuse the Aurora web screens: like the Apple TV app it is built from
scratch and talks straight to your Emby server. Aurora Guard sees it like any other device ("Aurora" on "Roku"): device limits, plans and end dates apply.

## What works in this version (stage 1: Movies and TV)

- Sign in with a username and password on the Roku keyboard. The server address is filled in and can be changed. The sign-in is kept between runs.
- Menu across the top: Home, Movies, TV Shows, Search, Favorites, Settings.
- Home: Continue Watching, Next Up, Recently Added Movies and TV Shows.
- Movies, TV Shows and Favorites as poster grids, more loading as you go down. Press **\*** (options) to change the order: A to Z, Recently added, Top rated.
- A title's page: the story, Play, Resume (and Start over), Add to Favorites, Mark watched. For a show: its seasons and episodes, and Play the next episode.
- Search (movies and shows).
- Playback with Roku's player. A file a Roku can play as it is (MP4 or MKV, H.264 or HEVC) is played directly; anything else is sent by the server as HLS.
  The server is told where you are, so Continue Watching is right on every device, and the next episode plays by itself.
- Settings: who is signed in, the server, and Sign out.

Not yet (later stages): Live TV and the TV guide, Sports, the Inbox, Requests, choosing subtitles and audio tracks, the provider's titles, Admin and the reseller panel.

## Try it on your Roku (developer mode)

1. On the Roku, turn on developer mode: press **Home 3 times, Up 2 times, Right, Left, Right, Left, Right**. Choose **Enable installer and restart**, accept, and
   write down the Roku's password and IP address (also under Settings, Network, About).
2. Download **Aurora-Roku.zip** from the GitHub release *Aurora for Roku (newest)* (the link is in the repository's Releases).
3. On a computer on the same Wi-Fi open `http://ROKU-IP-ADDRESS` in a browser. Sign in (user name **rokudev**, the password you chose).
4. Under **Development Application Installer** choose **Upload**, pick Aurora-Roku.zip and press **Install**. Aurora opens on the Roku.
5. To update, upload the newer zip the same way. (An app installed this way disappears if the Roku is reset; it is for testing.)

If something is wrong, the Roku prints messages to port 8085: `telnet ROKU-IP-ADDRESS 8085` shows them, which helps to find a problem.

## A private channel for customers (no public store)

Roku lets you publish a channel that is not in the Channel Store and that people add with a code.

1. Make a Roku developer account (developer.roku.com) and a channel in the **Developer Dashboard** (Manage My Channels, Add Channel, Non-Certified Channel).
2. Roku needs the channel **signed** by a key that belongs to you. On the Roku in developer mode: open the installer page, use the **Packager**
   (name the app, use the password from running `genkey` over telnet on port 8080 the first time), and download the signed `.pkg`. Keep the key
   and the password safe: every later update must be signed with the same key.
3. Upload the `.pkg` in the Dashboard. Roku gives a **channel code** (like AB1CDE). Customers add it at `my.roku.com`, Manage account, **Add channel with a code**, or on the Roku.
   The channel arrives within 24 hours.

Roku has changed its rules for private (non-certified) channels before, so check developer.roku.com for the current steps and limits before relying on this route. The developer-mode install above always works for testing.

## How it is built

- `manifest`: the channel's name, icons and screen size (1920 x 1080).
- `source/main.brs`: starts the app and keeps the server and the sign-in in the global node. `source/Common.brs`: shared helpers (saved settings,
  talking to Emby, turning items into posters).
- `components/`: `MainScene` (menu and layers), `HomePage`, `BrowsePage`, `SearchPage`, `SettingsPage`, `LoginScreen`, `DetailsScreen`,
  `PlayerScreen`, `PosterItem`, and `ApiTask` (every web request runs off the main thread).
- GitHub (`.github/workflows/aurora-roku.yml`) checks the channel with the BrighterScript compiler, packs it with `tools/build-roku.js` and publishes
  `Aurora-Roku.zip` to the release `aurora-roku`. To check it yourself: `cd roku && npx brighterscript@0.69.13 --project bsconfig.json`.

Nothing here could be run on a real Roku while it was written: the compiler proves the code is well formed, but a Roku is the real test. Tell me
what you see on the screen (and any message from port 8085) and it can be fixed quickly.
