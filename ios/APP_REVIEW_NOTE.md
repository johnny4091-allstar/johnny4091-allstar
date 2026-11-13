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

Aurora is a client app for a user's own media server (an Emby server). It contains no media of its own and does not provide any
content: it only plays what is on the server the user signs in to.

How to review it:

1. Open the app. On the sign-in screen enter the demo account:
   - Username: `<demo username>`
   - Password: `<demo password>`
2. The demo account is on a small library of free-to-use videos (<say what they are, for example public-domain films>).
   Open Movies or TV Shows, choose a title and press Play.
3. No payment, purchase or account creation takes place inside the app. Access to a user's own server account is arranged outside
   the app by the person who runs the server.

The app uses the network only to talk to the user's server (and to GitHub for release notes). It does not use advertising or
analytics tools. The privacy policy is at <https://your-website/privacy/>.

If anything does not work during review, please contact <your email> and the server will be checked straight away.

## Making the demo account (about 10 minutes)

1. **A small library of free titles.** On the PC running Emby, make a folder, for example `Demo`, and put in a few free or public-domain
   videos (archive.org has many) or your own clips. In Emby: Dashboard → Library → Add Media Library → name it Demo → choose that folder.
2. **The account.** In the Aurora app: Admin → Users → **Add user**. Username `applereview` (or anything you like), a strong password you
   will paste into App Store Connect, and 1 device. Do not make it an administrator.
3. **Only the demo library.** In Emby: Dashboard → Users → `applereview` → Library Access → turn off "Enable access to all libraries",
   then tick only **Demo**. (Check there is nothing else ticked, including Live TV.)
4. **Review account.** In Aurora: Admin → Users → `applereview` → turn on **Review account**.
5. **No end date.** On the same page, set **No end date** and save, so it can't expire during the review.
6. **Try it.** Sign out of the app, sign in as `applereview` on a phone, and check: only the Demo titles show, there is no Live TV tab and
   no Requests tab, and a video plays. Then put these details in the TestFlight sign-in box.

## Checklist before you submit

- [ ] The demo user exists in Emby, is **not** an administrator, can only see the small library, and has no end date or device limit
      in Aurora Guard (Admin → Users → the user → set no end date).
- [ ] The server and Aurora Guard are switched on and reachable from the internet for the whole review (it can take a day or two).
- [ ] In Aurora: Admin → Users → the demo user → turn on **Review account** (needs Guard 1.20.0 and the app version that has it). That hides Live TV, Requests and the provider's titles for this one account.
- [ ] The privacy policy page opens in a phone browser, and its contact line shows your email (set `contact` in `website/config.js`).
- [ ] The description and screenshots only show features that work in this version (see `ios/README.md`).
- [ ] You tried the build yourself on a real iPhone first.
