# Aurora

A Netflix-style web app for your own Emby media server. Plain HTML/CSS/JavaScript: no build step, no install.

## Features

- Opening screen (`splash.js`): a jump through space, a flash and shockwave, then the logo and "Where streaming is possible", drawn on a canvas (in a background worker where the device allows, so it stays smooth while the app starts) with the "Aurora Pulse" sound (`sounds/aurora-pulse.mp3`, rendered from the synthesiser in splash.js; Settings → Sound when Aurora opens turns it off). It stays up about 3.9 seconds (`SPLASH_MIN` in app.js). On a TV it draws fewer stars at a lower resolution; with reduced motion it shows the finished screen once.

Versions read `V2.5.4`. The CI build number N becomes `2.(N div 50).(N mod 50)` (build 254 is V2.5.4). The release is tagged `aurora-v2.5.4-b254`; the trailing build number is what the Android app compares to decide an update is newer, so it must keep rising, and older `2.0.N` installs still update normally.


- Sign in with your Emby username and password; everyone who signs in on a device gets a "Who's watching?" tile
  so they can switch back without retyping their password
- Works with a TV remote or keyboard: arrow keys move around, OK/Enter selects, Back closes
- Home page with a featured banner that flips between a few titles (dots to jump), a floating pill menu bar, and rows: Continue Watching, Next Up, Favorites,
  Recently Added for each library, Top Rated, Popular TV, and random genre rows
- TV Shows and Movies pages with genre, sort, and watched filters and infinite scroll
- Search
- A first-run guided tour: the screen dims, the real button being explained is outlined and an arrow points at it
  (tap, OK or Enter for the next step; Skip or Back ends it). It shows once per device and can be replayed in
  Settings → About → Replay tour. The wording and steps are in `tour-config.js`, one block per platform (phone, TV, web)
- Details pop-up with cast, genres, and rating; season picker and episode list for shows; "More Like This" for movies
- Favorites: save movies, shows and Live TV channels to the Favorites tab (the + on a title, the star on a channel, or hold OK on a TV remote), and mark as watched/unwatched
- Video player that plays files directly when the browser supports them and asks Emby to transcode (HLS) when it doesn't
- Player controls: play/pause, 10-second skip, seek bar, mute, full screen, audio track, subtitles, streaming quality,
  Skip Intro (when Emby has intro markers) and Next Episode
- Live TV (when it's set up in Emby and allowed for the user): a TV guide, a channel list, an "On Now" row on Home,
  and live playback with channel up/down. Channels from an M3U playlist or Xtream account work too
- Next-episode countdown when the credits start (Play Now or Watch Credits), and "Are you still watching?" after
  3 episodes in a row, or 4 hours of Live TV, with no button pressed (the stream stops so it doesn't use bandwidth or a tuner)
- Settings: audio language, subtitle language and when subtitles show (saved to the Emby account); subtitle size,
  color, edge and background, auto-play, "Are you still watching?" and streaming quality (saved on the device)
- Live TV remote: number keys show the channel name while typing and OK jumps at once; Last (or 0) goes back to the previous channel; tiles and the player's channel list show a progress bar for the programme on now and the next one; a failing channel asks the guard whether others reported it.
- First-time setup (`showFirstRun` in app.js): welcome, avatar (8 characters drawn in code x 6 colours), name, genres, favorite titles, language and subtitles, Live TV categories (only when Live TV is on), plan, then the tour. The profile is kept on the Emby account as the display preference `aurora-profile` ({avatar, name, genres, cats, done}), so it runs once per account; the tour still runs once per device. Admins and people who already saw the tour skip it; Settings → Your profile runs it again. Back goes to the previous step; Back on the first screen skips the setup.
- Reseller panel (`renderReseller`): credits hero, customer list with search/filter/sort/export, details with renew-with-plan, reset password (welcome message), hold and delete; announcements show on the panel like everywhere else.
- Maintenance mode (Aurora Guard 1.12.0; `maint`, `maintOn`, `renderMaintenance`, `adminMaintenance`): the admin switches tabs off for customers with a friendly message; `route()`, `openItem`, `playItem` and `playIptv` check `maintOn(key)`; the state is kept in `ef.maint` and refreshed every 2 minutes. Admins are never blocked.
- Speed test (`renderSpeedTest`, `#/speedtest`, Settings → Speed test; guard 1.14.0 for the upload half): ping with 10 small requests to `/System/Info/Public`, download from `/Playback/BitrateTest`, upload to the guard's `/speedtest/up`; `spdLive` / `spdFinal` turn samples into Mbps (the final figure skips the first 0.8 s); `spdAnswer` gives the plain-words result and suggested quality; results go in `ef.speed.hist`, the app log and (on request) Help & support.
- Offline downloads (Android app only; `Downloads.java`, `renderDownloads`, `startItemDownload`, `playDownload`): the page asks Emby for the original file (`/Items/{id}/Download`), Android's DownloadManager saves it in the app's own folder (Wi-Fi only by default, background, retries), and a finished file plays in the normal native player from its `file://` address, remembering the position. Downloads are deleted when the account has ended (`/account`) or the admin switches them off (Admin → Playback → Offline downloads); the account end date is kept so it also locks offline playback. If Aurora opens with no connection, the sign-in screen offers **Watch my downloads**.
- Notifications and help (Aurora Guard 1.11.0): the bell (`refreshInbox`, `renderInbox`, banners from `#announce`), Help & support (`renderHelp`, attaches `helpDiag()`), Refer a friend (`renderRefer`), Your Aurora (`renderStats`), and for admins Inbox, Announcements and Support tabs (`adminInbox`, `adminAnnounce`, `adminSupport`). The reseller panel also has bulk renew, reminder messages, credit requests and a monthly report.
- Resellers (`adminResellers` in Admin → Customers, `renderReseller` at `#/reseller`, Aurora Guard 1.10.0): the admin adds a reseller (an Emby account), gives them credits and picks the plans they may sell; the reseller creates and renews their own customers with those credits (welcome message to copy, free 2-day trial, details, password reset). Plans have an optional **Reseller credits** cost (blank = connections × months). The profile-menu entry only shows for resellers (`state.isReseller`, from `/reseller/me`).
- Status and "Is it just me?" (`renderStatus`, `#/status`, opened from Settings → Status): checks the internet, the Aurora server and (Xtream) the Live TV provider from the device, then asks Aurora Guard `/service-status` what others see (channel reports, outages, sports feed, last 24 hours, the admin's message from Admin → Server health). The answer says whether it is just this device or everybody. "Tell me when it's back" watches once a minute for up to an hour while Aurora stays open. Without the guard it still checks the device, the server and the provider.
- Live TV → Sports (`renderIptvSports`): games found in the channel guide on channels in sport-named categories (NFL, NBA, Sports...), grouped when several channels carry the same game, split into Live now and Starting soon (next 12 hours), filterable by league (from the title, then the category, then common US team names) and by favorite channels. Replays, highlights and studio shows are left out. Version 2 adds live scores and the day's games from Aurora Guard's score feed (matched to channels by team name, aliases and TV network), favourite teams and leagues from the first-time setup (and Settings), a Spoiler-free switch, and **Remind me** (a notification from the Android app via `Reminders.java`, a toast while Aurora is open; saved on the account as `aurora-sports`). Version 3 (Guard 1.15.0): a day strip (today and the next six days), a big game at the top (a live game of your teams first), colour-edged cards, and a **game sheet** (tap a game) with Stats, Plays, Standings and Channels; channels are ranked (the one you picked before, a favourite, the league's broadcaster, HD over SD) with the best one tagged, and the pick is remembered per league (`ef.sports.picks`); per-game **score and final-score alerts** (shown while Aurora is open, saved in `aurora-sports` as `follow`). Spoiler-free hides scores, stats and plays. In a browser or without a guide it shows what's on now from the provider's short listing.
- Kids mode (Settings, per device): only titles with an allowed rating (Little kids / Kids / Teens; unrated titles are hidden), Live TV,
  Requests, Admin and Settings closed, and a 4-digit PIN (on-screen number pad, works with a remote) to leave. The rating filter is
  applied to every Emby answer in `api()` (`kidsFilter`); episodes with no rating of their own follow their show. It keeps young
  children to their own shelf; it is not a security lock.
- Home: a "New This Week" row, and a note about the customer's own plan (ends within 7 days, or their extension request was answered) from Aurora Guard.
- The Android app checks this repository's Releases for a newer version, offers to update, and installs it itself
- Requests tab (Android app) for Jellyseerr: browse Trending, Popular and Coming Soon, search, request movies or
  chosen TV seasons, and follow your requests. People sign in to Jellyseerr with their Emby details automatically.
  Requests are controlled by `aurora-config.json` at the top of the repository, which the app reads at start-up:
  set `"requestsServer"` to your Jellyseerr address and `"requestsEnabled"` to `true` to switch the tab on.
  While it's off, the tab shows a "Coming soon" page. Edit the file on GitHub and every installed app picks up the
  change the next time it opens; no new APK is needed.
- Trailers: a Trailer button on movies and shows (and in Requests). Trailer files in the library play in Aurora;
  online (YouTube) trailers open in the YouTube app, or in a window inside Aurora where there isn't one
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

The release signing key is NOT in this repo: it is kept in GitHub secrets (see `android/SIGNING.md`). Every build must be signed with the same key so it can update the last one.
That's fine for a personal app, but anyone could sign an app that installs over it, so only install Aurora
APKs from this repo's Releases page.

## Third-party files

- `vendor/hls.min.js`: [hls.js](https://github.com/video-dev/hls.js), Apache License 2.0 (`vendor/hls.js-LICENSE.txt`)
- `fonts/`: Inter and Bebas Neue, SIL Open Font License 1.1 (license files alongside)
