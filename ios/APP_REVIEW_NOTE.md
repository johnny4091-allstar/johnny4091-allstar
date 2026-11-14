# Notes for Apple (TestFlight Beta App Review and, later, App Review)

Copy the parts below into App Store Connect. Fill in the angle brackets. Never put a real customer login or your admin login here.

## Where each piece goes

| In App Store Connect | What to paste |
| --- | --- |
| TestFlight → Test Information → **Beta App Description** | The short description below |
| TestFlight → Test Information → **What to Test** | The "What to test" text below |
| TestFlight → Test Information → **Feedback Email** | An email you read |
| TestFlight → Test Information → **Privacy Policy URL** | `https://<your website>/privacy/` |
| TestFlight → Test Information → **Review Information** → Sign-in required | tick it, then the demo username and password |
| TestFlight → Test Information → **Review Information** → **Notes** | The review note below |

## Beta App Description (short)

Aurora is a player for your own media server. Sign in with your server account to browse your movies and shows, resume where
you stopped, and request new titles.

## What to test

1. Sign in with the demo account below.
2. Open Movies and TV Shows, pick a title and play it. Try pausing and seeking.
3. Open Favorites, then Settings, then sign out and back in.

## Review note (paste into the Notes box)

Aurora is a client app for a user's own media server (an Emby server). It contains no media of its own. It plays what is on the
server the user signs in to, including the server's Live TV: a live TV playlist that the person who runs the server sets up. The app
supplies no channels itself. Live TV is part of the app for every account, including the demo account below.

How to review it:

1. Open the app. On the sign-in screen enter the demo account:
   - Username: `<demo username>`
   - Password: `<demo password>`
2. Open Movies or TV Shows, choose a title and press Play. Open Live TV to see the channels the server provides and press a channel
   to watch it. (<say what the demo library contains>)
3. No payment, purchase or account creation takes place inside the app. Access to a user's own server account is arranged outside
   the app by the person who runs the server.

The app uses the network only to talk to the user's server (and to GitHub for release notes). It does not use advertising or
analytics tools. The privacy policy is at <https://your-website/privacy/>.

If anything does not work during review, please contact <your email> and the server will be checked straight away.

## Making the demo account (about 10 minutes)

The reviewer must see the same app your customers see. Don't hide any feature from this account. Give it a login that works and a few
titles to play.

1. **Some titles to play.** In Emby, make a library (for example `Demo`) with a few free or public-domain videos (archive.org has many)
   or your own clips. Or let the demo user see a normal library: your choice.
2. **The account.** In the Aurora app: Admin → Users → **Add user**. Username `applereview` (or anything you like), a strong password you
   will paste into App Store Connect. Do not make it an administrator. It gets Live TV like any other account.
3. **No end date.** On the user's page, set **No end date** and save, so it can't expire during the review.
4. **Try it.** Sign in as `applereview` on a phone and check that you can browse and play a title and that Live TV works.
   Then put these details in the TestFlight sign-in box.

## Checklist before you submit

- [ ] The demo user exists in Emby, is **not** an administrator, and has no end date or device limit that could lock it out
      (Admin → Users → the user → set no end date).
- [ ] The server and Aurora Guard are switched on and reachable from the internet for the whole review (it can take a day or two).
- [ ] The demo account sees the same app as every customer. Nothing is hidden from it, and the note above describes Live TV honestly.
- [ ] The privacy policy page opens in a phone browser, and its contact line shows your email (set `contact` in `website/config.js`).
- [ ] The description and screenshots only show features that work in this version (see `ios/README.md`).
- [ ] You tried the build yourself on a real iPhone first.
