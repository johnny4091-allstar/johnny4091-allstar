# Aurora for Roku

A native Roku app for the same server as the Aurora Android and web apps. It is written in BrightScript and
SceneGraph, so it is a separate app (Roku cannot run the web app).

**What it does:** sign in, Home (Continue Watching, Next Up, new movies and shows), Movies, TV Shows, Search,
seasons and episodes, Play / Resume, watched marks (including "mark a whole season"), and it reports playback
progress to the server like the other apps. Films play directly when the Roku can handle the file, and are
converted by the server when it can't.

**First-run tour:** the first time you sign in, Aurora walks you through the Browse tiles and Continue Watching
with a dimmed screen, an outline around the real tile and an arrow (OK or Right for the next step, Back to skip).
Choose **Replay tour** in the Browse row to see it again. The words and steps are in `components/TourConfig.brs`;
the drawing is in `components/Tour.brs`. The arrow images are made by `tools/make-tour-images.py`.
It needs Roku OS 9 or newer (older ones skip the tour).

**Not in this first version:** Live TV, requests, subtitles and audio-track pickers, profiles and the admin pages.

## Install it on your Roku (sideloading)

1. On the Roku remote press: Home ×3, Up ×2, Right, Left, Right, Left, Right. Choose **Enable installer and
   restart**, accept the terms and set a password. Note the Roku's IP address (Settings → Network → About).
2. On a computer on the same network, open `http://<roku-ip>` in a browser. Sign in as `rokudev` with your password.
3. Upload `aurora-roku.zip` and choose **Install**. Aurora starts at once and shows on the Roku's home screen
   until the Roku restarts or is updated.

Sideloaded apps are for you and a few devices of your own. To give the app to customers it has to be published
as a Roku channel, which needs a Roku developer account and Roku's certification (see below).

## Updates

A sideloaded Roku app cannot replace itself. Aurora instead checks `aurora-config.json` in the repository when it
opens: `"rokuBuild"` is the newest build and `"rokuMinBuild"` (optional) the oldest still allowed. An older copy shows
"A newer version is available"; below the minimum it shows an update message it cannot be dismissed from.
When you ship a new version, raise `build_version` in `roku/manifest`, rebuild the zip, and set `rokuBuild` to match.

For updates that install themselves, publish the app as a **non-certified channel** in a Roku developer account:
Roku gives you a private link, customers add the channel from it, and every new version you upload reaches
them automatically. That route needs no review but is limited to 20 non-certified channels per account.

## Build the zip yourself

```sh
cd roku && zip -r ../aurora-roku.zip manifest source components images
```

(`aurora-roku.zip` in the repository is built from these files.)

## Settings

The server address is set in `source/main.brs` (`server`). The app talks to `/emby/...` on that server over https.
