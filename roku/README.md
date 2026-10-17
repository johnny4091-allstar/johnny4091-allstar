# Aurora for Roku

A native Roku app for the same server as the Aurora Android and web apps. It is written in BrightScript and
SceneGraph, so it is a separate app (Roku cannot run the web app).

**What it does:** sign in, Home (Continue Watching, Next Up, new movies and shows), Movies, TV Shows, Search,
seasons and episodes, Play / Resume, watched marks (including "mark a whole season"), and it reports playback
progress to the server like the other apps. Films play directly when the Roku can handle the file, and are
converted by the server when it can't.

**Not in this first version:** Live TV, requests, subtitles and audio-track pickers, profiles and the admin pages.

## Install it on your Roku (sideloading)

1. On the Roku remote press: Home ×3, Up ×2, Right, Left, Right, Left, Right. Choose **Enable installer and
   restart**, accept the terms and set a password. Note the Roku's IP address (Settings → Network → About).
2. On a computer on the same network, open `http://<roku-ip>` in a browser. Sign in as `rokudev` with your password.
3. Upload `aurora-roku.zip` and choose **Install**. Aurora starts at once and shows on the Roku's home screen
   until the Roku restarts or is updated.

Sideloaded apps are for you and a few devices of your own. To give the app to customers it has to be published
as a Roku channel, which needs a Roku developer account and Roku's certification (see below).

## Build the zip yourself

```sh
cd roku && zip -r ../aurora-roku.zip manifest source components images
```

(`aurora-roku.zip` in the repository is built from these files.)

## Settings

The server address is set in `source/main.brs` (`server`). The app talks to `/emby/...` on that server over https.
