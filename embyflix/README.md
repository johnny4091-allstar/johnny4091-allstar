# EmbyFlix

A Netflix-style web app for your own Emby media server. Plain HTML/CSS/JavaScript: no build step, no install.

## Features

- Sign in with your Emby username and password
- Home page with a rotating hero banner and rows: Continue Watching, Next Up, My List,
  Recently Added for each library, Top Rated, Popular TV, and random genre rows
- TV Shows and Movies pages with genre, sort, and watched filters and infinite scroll
- Search
- Details pop-up with cast, genres, and rating; season picker and episode list for shows; "More Like This" for movies
- Add to My List (Emby favorites) and mark as watched/unwatched
- Video player that plays files directly when the browser supports them and asks Emby to transcode (HLS) when it doesn't
- Resume where you left off, progress reported back to Emby, and auto-play of the next episode
- Works on phones, tablets, and desktops

## Run it

1. Download this `embyflix` folder.
2. Open `index.html` in Chrome, Edge, Firefox, or Safari. Double-clicking it works, or you can serve the folder:
   `python3 -m http.server 8080`, then go to http://localhost:8080
3. Sign in with your Emby username and password, the same ones you use on Emby's own web page.

EmbyFlix always connects to `https://emby4836.duckdns.org:8920`. To point it at a different server, change
`DEFAULT_SERVER` at the top of `app.js`.

## Notes

- The server's certificate must be valid (for example Let's Encrypt). If opening the server address in your browser
  shows a certificate warning, the app can't connect until that's fixed.
- If playback won't start for a file, check that transcoding is enabled for your user in Emby.

## Android app

The `android/` folder wraps EmbyFlix in an Android app (Android 8.0 and newer). Every push that changes
`embyflix/` or `android/` builds a new APK with GitHub Actions and publishes it on the repository's
**Releases** page as `EmbyFlix.apk`.

To install: open the latest release on your phone, download `EmbyFlix.apk`, open it, and allow installing
apps from that source when Android asks. New versions install over the old one and keep you signed in.

In the app, videos play full screen in landscape, the screen stays on while watching, and the back button closes
the player and pop-ups.

To build it yourself, install the Android SDK and Gradle 8.x, then run `gradle assembleRelease` in `android/`.

The signing key (`android/embyflix.keystore`) is in this public repo so every build can update the last one.
That's fine for a personal app, but anyone could sign an app that installs over it, so only install EmbyFlix
APKs from this repo's Releases page.
