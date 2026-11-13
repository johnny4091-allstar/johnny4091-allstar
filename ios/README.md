# Aurora for iPhone

A native iPhone app (iPhone only) that shows the same Aurora screens as the Android app and the website. The screens in
`../aurora` are bundled into the app. A small native layer (`Aurora/Bridge.swift`) provides the few things a web page can't do
itself.

## What works in this version (stage 1)

- Sign in, Home, Movies, TV Shows, Favorites, search, the Requests tab (through the app, like Android) and the Admin pages.
- Movies and shows play in the page's own player: direct when the iPhone can, converted by your server (HLS) when it can't.
- Not yet (the screens hide them): Live TV channels and the guide, the guide's live picture, the provider's movies and TV shows,
  downloads, reminders, the app lock. These come in the next stages.
- Updates come through TestFlight, not from GitHub (the app's own update check is switched off on iPhone).

## How it is built

`project.yml` is the project description. `xcodegen generate` (in this folder) creates `Aurora.xcodeproj` from it; that project
is not committed. GitHub builds it on a Mac with `.github/workflows/aurora-ios.yml`:

1. Without Apple secrets: it compiles the app for the iPhone simulator (a check that the code is sound).
2. With the secrets below: it also signs the app and sends it to TestFlight.

Nothing here can be run on an iPhone until it comes through TestFlight.

## Setting up TestFlight (needs an Apple Developer account, $99 a year)

1. In **App Store Connect → Apps**, add a new iOS app. Pick a bundle ID (for example `com.yourname.aurora`) and the name Aurora.
2. In **App Store Connect → Users and Access → Integrations → App Store Connect API**, make a key with the **Admin** role.
   Download the `.p8` file once (Apple lets you download it only once) and note the **Key ID** and the **Issuer ID**.
3. In this GitHub repository, **Settings → Secrets and variables → Actions → New repository secret**, add:

   | Secret | Value |
   | --- | --- |
   | `APPLE_TEAM_ID` | your 10-character Team ID (Apple Developer → Membership) |
   | `IOS_BUNDLE_ID` | the bundle ID from step 1 |
   | `ASC_KEY_ID` | the Key ID |
   | `ASC_ISSUER_ID` | the Issuer ID |
   | `ASC_KEY_BASE64` | the `.p8` file as one line of Base64 (`base64 -w0 AuthKey_XXXX.p8`) |

4. Push (or run the workflow by hand). The build appears in **App Store Connect → TestFlight** after Apple has processed it.
   Add testers there, or turn on a public link.

The key and the secrets stay in GitHub; never paste them into a chat or a file in the repository.
