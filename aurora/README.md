# Aurora

A Netflix-style web app for your own Emby media server. Plain HTML/CSS/JavaScript: no build step, no install.

## Features

- Sign in with your Emby username and password; everyone who signs in on a device gets a "Who's watching?" tile
  so they can switch back without retyping their password
- Works with a TV remote or keyboard: arrow keys move around, OK/Enter selects, Back closes
- Home page with a rotating hero banner and rows: Continue Watching, Next Up, My List,
  Recently Added for each library, Top Rated, Popular TV, and random genre rows
- TV Shows and Movies pages with genre, sort, and watched filters and infinite scroll
- Search
- Details pop-up with cast, genres, and rating; season picker and episode list for shows; "More Like This" for movies
- Add to My List (Emby favorites) and mark as watched/unwatched
- Video player that plays files directly when the browser supports them and asks Emby to transcode (HLS) when it doesn't
- Player controls: play/pause, 10-second skip, seek bar, mute, full screen, audio track, subtitles, streaming quality,
  Skip Intro (when Emby has intro markers) and Next Episode
- Live TV (when it's set up in Emby and allowed for the user): a TV guide, a channel list, an "On Now" row on Home,
  live playback with channel up/down, and recording single shows or whole series, plus a Recordings page with
  scheduled recordings you can cancel
- Resume where you left off, progress reported back to Emby, and auto-play of the next episode
- Works on phones, tablets, and desktops

## Run it

1. Download this `aurora` folder.
2. Open `index.html` in Chrome, Edge, Firefox, or Safari. Double-clicking it works, or you can serve the folder:
   `python3 -m http.server 8080`, then go to http://localhost:8080
3. Sign in with your Emby username and password, the same ones you use on Emby's own web page.

Aurora always connects to `https://emby4836.duckdns.org:8920`. To point it at a different server, change
`DEFAULT_SERVER` at the top of `app.js`.

## Notes

- The server's certificate must be valid (for example Let's Encrypt). If opening the server address in your browser
  shows a certificate warning, the app can't connect until that's fixed.
- If playback won't start for a file, check that transcoding is enabled for your user in Emby.

## Android and Android TV app

The `android/` folder wraps Aurora in an Android app for phones, tablets and Android TV (Android 8.0 and newer).
The same APK works on all of them; on a TV it shows up in the apps row with the Aurora banner. Every push that changes
`aurora/` or `android/` builds a new APK with GitHub Actions and publishes it on the repository's
**Releases** page as `Aurora.apk`.

To install: open the latest release on your phone, download `Aurora.apk`, open it, and allow installing
apps from that source when Android asks. New versions install over the old one and keep you signed in.

In the app, videos play full screen in landscape, the screen stays on while watching, and the back button closes
the player and pop-ups.

On Android TV, use the remote's arrows to move around and OK to select. Selecting a text box opens the on-screen
keyboard. While a video plays: OK pauses, left/right skips 10 seconds, up/down shows the controls, and the remote's
play/pause, fast-forward and rewind buttons work too. When watching Live TV, up/down (or the remote's channel
buttons) change channel, and the remote's Guide button opens the TV guide.

To install on a TV, use an app like Downloader (enter the APK link) or copy the APK over with a USB stick, and allow
installing from unknown sources when asked.

To build it yourself, install the Android SDK and Gradle 8.x, then run `gradle assembleRelease` in `android/`.

The signing key (`android/embyflix.keystore`) is in this public repo so every build can update the last one.
That's fine for a personal app, but anyone could sign an app that installs over it, so only install Aurora
APKs from this repo's Releases page.

## Third-party files

- `vendor/hls.min.js`: [hls.js](https://github.com/video-dev/hls.js), Apache License 2.0 (`vendor/hls.js-LICENSE.txt`)
- `fonts/`: Inter and Bebas Neue, SIL Open Font License 1.1 (license files alongside)
