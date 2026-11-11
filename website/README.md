# Aurora website

A plain-files website (no build step) that tells people about Aurora and lets them sign up for a free trial.

- `index.html`: the public page: features, Sports, prices, sign-up form (with referral and discount codes), the Downloader code and app download, FAQ. Prices are read from the Aurora Guard (`GET /site/info`), so they match Admin → Plans; the page has the standard two plans built in as a fallback.
- `admin/index.html`: the admin page (not linked from the site, not indexed). Sign in with an Emby administrator account; make discount codes (percent or dollars off, which plans, how many uses, end date), switch them on or off and see how many times each was used.
- `reseller/index.html`: the reseller page (not linked except by the "Reseller sign in" button at the bottom, not indexed). A reseller signs in with their Emby account and gets the same tools as the app's Reseller panel: credits, ask for credits, add a customer (paid plan or free trial), renew, reset password, sign out devices, hold, delete, search, filters and CSV export. The Guard enforces everything: they only see their own customers and only sell the plans you gave them.
- `config.js`: the Guard address, the Android file link, the Downloader code, the web app address and a contact line. Blank `webAppUrl` / `contact` hide those parts of the page.
- `netlify.toml`: publish this folder as it is.

## What the Aurora Guard needs (1.16.1)

1. Copy `server/aurora-guard.js` to the PC and restart the "Aurora Guard" task.
2. Sign-up is **off** until you add `"signupEnabled": true` to `config.json`. Optional: `signupTrialDays` (2), `signupTrialConnections` (1), `signupMaxPerDay` (30), `signupPerIpPerDay` (3).
3. The Guard must be reachable from the internet over https (the same address the app already uses, `https://emby4836.duckdns.org:8922`). It allows calls from any website; every admin call still needs an administrator's token.

## How it behaves

- Sign-up makes the Emby account, starts a free trial and records the email. One account per email; a few tries per address per hour; a few accounts per address and per day; a hidden field catches robots. Codes are checked **before** the account is made, so a wrong code never leaves a half-made account.
- A referral code gives both people the usual free days. A discount code is saved on the account and takes money off the first paid plan it works on (when you put a plan on the account in Admin → Users, the recorded price is the discounted one and the change log says so).
- Admin → Users shows a waiting discount next to the customer.
