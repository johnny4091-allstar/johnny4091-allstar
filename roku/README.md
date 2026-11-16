# Aurora for Roku

A Roku channel (SceneGraph) that signs in to your Emby server like the other Aurora apps and offers **Movies**, **TV Shows** and **Live TV**
(the same Live TV settings as every other Aurora app; adult categories are never shown on Roku). Playing a title tells the server, so
Continue Watching and Aurora Guard see the Roku as a device ("Aurora" on "Roku").

Not in this first version: the TV guide ("now playing"), Favorites, Requests, subtitles choice, and Continue Watching on the home screen.

## Get the channel file

Every change under `roku/` is checked on GitHub (Actions → "Build Aurora Roku channel") and packed as `aurora-roku.zip` under the run's **Artifacts**.
The check is a syntax and reference check only; nobody has run this channel on a real Roku from here, so test it on yours first.

## Try it on your Roku (sideload)

1. On the Roku remote press: Home ×3, Up ×2, Right, Left, Right, Left, Right. Turn on **Developer mode**, set a password, and note the Roku's IP address.
2. In a browser on the same network open `http://<roku ip>` , sign in as `rokudev` with that password, and **Upload** `aurora-roku.zip`, then **Install**.
3. Open Aurora on the Roku, sign in, play something. (Leave the install box with **Screenshot** if you want to send one.)

## Put it in the Roku Channel Store

1. Create a free developer account at developer.roku.com and add a channel (Manage My Channels → Add channel → Non-Certified for a private channel, or Public for the store).
2. On the Roku's developer page (step 2 above) open **Packager** (`http://<roku ip>:80/plugin_package`), name the app, set the password Roku gives you, and **Package**. Download the `.pkg`.
   (Roku needs the package made on a real Roku, so a Roku in developer mode is required; the first packaging also creates your signing key. Keep that key safe.)
3. Upload the `.pkg` and fill in the store listing. Use `REVIEW_NOTE.md` for the "testing information" and sign-in boxes.
4. A private (non-certified) channel works with a link and needs no review; a public channel goes through Roku's certification.

## Developing

`roku/manifest`, `roku/source/main.brs`, `roku/components/MainScene.brs` (almost everything), `ApiTask.brs` (web requests).
Check locally with `npx brighterscript --rootDir roku --noEmit --createPackage false`.
