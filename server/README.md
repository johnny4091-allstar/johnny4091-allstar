# Aurora Guard

> **Status: switched off.** Aurora does not contact the guard unless `"guardEnabled": true` is set in
> `aurora-config.json`. To stop the service on the PC, see "Stopping the guard" at the end.

Enforces Aurora's per-account device limits and expiration dates on the Emby server. It applies to Emby's
own apps too, not just Aurora.

- **Store:** `data\limits.json` holds each account's device limit and expiration date. Only this program
  reads it. Emby users can't reach it, unlike the display preferences older versions used.
- **Admin endpoint:** Aurora's **Admin → Users** page reads and saves limits here. Each request carries the
  caller's own Emby token, and the guard checks with Emby that it belongs to an **Emby administrator**. Other
  tokens get `403`.
- **Every minute**, using its own Emby API key, it:
  - disables accounts past their expiration date (`POST /Users/{id}/Policy`, `IsDisabled: true`);
  - re-enables accounts it disabled once their date is extended;
  - signs out devices over an account's limit. The newest devices go first; each gets a message, its
    playback is stopped, and the device is removed so it has to sign in again.

Administrator accounts are never limited or disabled.

## Setup (Windows, on the Emby server PC)

1. **Install Node.js:** the LTS version from <https://nodejs.org>, with the default options.
2. **Copy the files:** copy this `server` folder to the PC, for example to `C:\AuroraGuard`.
3. **Create an API key:** in the Emby dashboard → **Advanced → API Keys → New API Key**, named "Aurora Guard".
4. **Fill in the settings:** copy `config.example.json` to `config.json` and set:
   - `apiKey`: the key from step 3.
   - `embyUrl`: how this PC reaches Emby, usually `http://127.0.0.1:8096`.
   - `pfxPath` / `pfxPassphrase`: the **same .pfx certificate Emby uses** for `https://emby4836.duckdns.org:8920`
     (Emby dashboard → Network → "Custom SSL certificate path"). Aurora only talks to the guard over https.
   - `port`: `8922` (Aurora expects this unless `guardUrl` in `aurora-config.json` says otherwise).
   - Leave `"dryRun": true` for now.
5. **Start it:** open **PowerShell as Administrator** in the folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
   ```

   First it **checks the certificate and the Emby API key** and stops with an explanation if either is wrong.
   Then it makes the guard start with Windows and restart if it stops, opens the port in Windows Firewall, and
   limits the folder to Administrators. The guard is started as `node --openssl-legacy-provider aurora-guard.js`:
   the flag lets Node.js open older `.pfx` certificates (RC2 / 3DES encryption, which Windows used to export by
   default) and makes no difference for a modern one.
6. **Forward the port:** on your router, forward TCP port **8922** to this PC, as you did for 8920.
7. **Check it's reachable:** from a phone off Wi-Fi, open <https://emby4836.duckdns.org:8922/health>. You
   should see `{"ok":true,...}`.
8. **Watch a dry run:** open Aurora → **Admin → Users**. The Enforcement section shows the last check. For a
   day, look in `data\guard.log` at the `[dry run] would ...` lines. Make sure nothing there is something you
   don't want.
9. **Turn enforcement on:** set `"dryRun": false` in `config.json` and restart the task (Task Scheduler →
   Aurora Guard → End, then Run).

## Settings (`config.json`)

| Setting | Meaning |
|---|---|
| `embyUrl` | Emby as seen from this PC |
| `apiKey` | Emby API key the guard acts with |
| `port`, `host` | Where the guard listens (default `0.0.0.0:8922`) |
| `pfxPath`, `pfxPassphrase` | https certificate. Without one, the guard only runs on `127.0.0.1` |
| `alertWebhookUrl` | Where alerts go (a Discord webhook, an ntfy.sh topic, or any web address that takes JSON). Blank (the default) = no alerts |
| `alertFormat` | `auto` (default: Discord and ntfy addresses are recognised, anything else gets JSON), or `discord`, `ntfy`, `json` |
| `intervalSeconds` | How often it checks (default 60, minimum 20) |
| `activeWindowMinutes` | A device counts as in use if it talked to Emby this recently (default 5) |
| `defaultLimit` | Device limit for accounts without their own (default 2) |
| `diskPaths`, `diskAlertPercent` | Drives to show free space for (default: the guard's own drive) and the free-space level that sends an alert (default 10) |
| `sharingNetworks`, `sharingSimultaneousMinutes` | When Admin → Sharing flags an account (defaults 4 and 10) |
| `dryRun` | `true`: only log what it would do |
| `exitOnCertError` | `false` (default): if the certificate can't be loaded, keep running the every-minute check without the https endpoint. `true`: stop instead |

## Endpoints

| Endpoint | Who can call it | What it does |
|---|---|---|
| `GET /health` | Anyone | Says the guard is running. No data. |
| `GET /check?userId=&deviceId=&phase=` | The signed-in user, about themselves | Returns whether Aurora should let them in or play, with a message. This is only so Aurora can explain up front; it doesn't enforce anything. |
| `POST /report` | The signed-in customer | Keeps a channel report and, if set up, passes it to the provider. |
| `GET /provider`, `PUT /provider`, `DELETE /provider/key`, `POST /provider/test` | Emby administrators | The provider's API settings; the key is never returned. |
| `GET /reports`, `DELETE /reports` | Emby administrators | The reported channels. |
| `GET /status` | Anyone | Two plain-text lines: `Guard: online` and `Aurora: online/offline`. |
| `GET /status/users` | Emby administrators | Live device counts per account (see above). |
| `GET /plans`, `POST /plans`, `PUT /plans/{id}`, `DELETE /plans/{id}` | Emby administrators | The subscription plans, with this month's and last month's totals and the history. |
| `POST /limits/{userId}/plan` | Emby administrators | Puts a plan on an account: `{planId, mode: "extend" or "today", price?}`. |
| `GET /plans/public?userId=` | The signed-in user | The plans on offer (name, price, length, connections), for the renewal request. |
| `GET /account?userId=` | The signed-in user, about themselves | Their plan: devices allowed and in use, the date access ends, and the state of an extension request. |
| `POST /extension` | The signed-in customer | Asks for an extension (one waiting at a time, 4 a month). Sends an alert. |
| `GET /extensions`, `PUT /extensions/{id}` | Emby administrators | The requests; `{action: "approve", days}` or `{action: "deny", message}`. |
| `GET /connections`, `PUT /connections` | Emby administrators | TV provider streams in use now, today's peak, and `{limit, alertAt}` for the alerts. |
| `GET /channel-status?userId=&channel=` | The signed-in user | How many *other* people reported that channel in the last hour (a number, no names), for the "is it just me?" line in the live player (guard 1.7.0). |
| `GET /sports/games`, `GET /sports/teams?league=`, `GET /sports/aliases`, `GET /sports/day?date=YYYYMMDD`, `GET /sports/game?league=&id=`, `GET /sports/standings?league=` | The signed-in user | Live scores and the day's games for the Sports tab, a league's teams (for the setup), and the admin's name aliases (guard 1.8.0); a later day's games, one game's stats and plays, and a league's standings (guard 1.15.0, asked on demand and cached for 25 seconds to 15 minutes). |
| `GET /resellers`, `POST /resellers`, `PUT /resellers/{id}`, `POST /resellers/{id}/credits`, `GET /resellers/{id}/log`, `POST /resellers/{id}/password` | Emby administrators | Resellers (guard 1.10.0): list them with their credits, add one (this also creates their Emby login), change name, contact, plans they may sell or suspend them, add / remove / set credits with a reason, see the ledger, make a new password. |
| `GET /reseller/me`, `POST /reseller/customers`, `PUT`/`DELETE /reseller/customers/{id}`, `POST /reseller/customers/{id}/renew`, `/password`, `/signout`, `/hold` | The signed-in reseller, for customers they created | The reseller panel: credits, plans with their credit cost, customers; create a customer (an Emby account plus the plan, paid in credits, or a free 2-day trial), renew, edit details, reset the password, sign out devices. Nothing about any other account is reachable. |
| `GET /inbox`, `POST /inbox/read` | The signed-in user | The notification bell (guard 1.11.0): announcements for them, plan-ending notices (7 / 3 / 1 days, ended), new titles this week, replies from support, and the unread count. |
| `GET /support`, `POST /support` (with `userId`) | The signed-in user | Their Get help conversation; sending adds the details Aurora attaches (version, device, connection, what was playing, recent problems). 10 messages an hour. |
| `GET /referral`, `POST /referral/redeem` | The signed-in user | Their referral code and friends; using a friend's code (first 14 days of an account, once) gives both people `referralDays` free days. |
| `GET /stats` | The signed-in user | Their own week: minutes watched, last week, Live TV minutes, most watched. |
| `POST /reseller/credit-request`, `POST /reseller/renew-many` | The reseller | Ask the admin for credits; renew several of their customers at once (all or nothing, checked against their credits first). |
| `GET/POST /announcements`, `DELETE /announcements/{id}` | Emby administrators | Messages for customers: everyone, one plan or one reseller's customers; they expire by themselves. |
| `GET /support`, `POST /support/{id}/reply`, `PUT /support/{id}` | Emby administrators | The support inbox: all conversations with their diagnostics, reply, mark solved or reopen. |
| `GET /credit-requests`, `PUT /credit-requests/{id}`, `GET /admin-inbox` | Emby administrators | Reseller credit requests (approve adds the credits, deny closes it) and one summary of everything waiting for the admin. |
| `GET /maintenance`, `PUT /maintenance` | The signed-in user (read), Emby administrators (write) | Maintenance mode (guard 1.12.0): which parts of Aurora (movies, tv, favorites, livetv, sports, requests, downloads) are switched off for customers, the message and an optional "back around" note. |
| `POST /speedtest/up?userId=` | The signed-in user | The upload half of Settings → Speed test (guard 1.14.0): the app sends a few seconds of data (up to 48 MB accepted, then thrown away) and times it itself. 12 tests an hour per customer. |
| `GET /service-status?userId=` | The signed-in user | The Status page (guard 1.9.0): whether the server answers, channels several other viewers reported in the last 15 minutes (counts and channel names only), the sports feed, the last 24 hours, recent outages and the admin's message. While the server is down it still answers, with the outage only. |
| `PUT /status-note` | Emby administrators | The message shown at the top of every customer's Status page (empty clears it). |
| `GET /sports/status`, `PUT /sports/settings`, `PUT /sports/aliases`, `POST /sports/refresh` | Emby administrators | What the scores feed is doing, which leagues are on, the aliases, and "ask the feed again now" (guard 1.8.0). |
| `GET /usage?days=` | Emby administrators | Minutes watched per day, per account and per title (guard 1.6.0). |
| `GET /sharing`, `DELETE /sharing/{userId}` | Emby administrators | Accounts seen on many networks or playing from two at once; clear one's history (guard 1.6.0). |
| `GET /server` | Emby administrators | Processor, memory, free disk space, streams now, and the last 24 hours (guard 1.6.0). |
| `GET /audit`, `POST /audit` | Emby administrators | Who changed what; the app also writes the account changes it makes straight in Emby (guard 1.6.0). |
| `GET /limits`, `GET /actions` | Emby administrators | Reads the store and the recent actions. |
| `PUT /limits/{userId}` | Emby administrators | Sets `{limit, expires: "YYYY-MM-DD" or null}` and applies it at once. |
| `DELETE /limits/{userId}`, `PUT /limits/{userId}/manual`, `PUT /migrated` | Emby administrators | Housekeeping. |

## Usage, sharing, server health and the audit log (guard 1.6.0)

All four are worked out from the sessions list the guard already reads every minute, so they add no load on Emby, and only
Emby administrators can read them. They appear in Aurora's Admin menu as **Usage**, **Sharing**, **Server health** and **Audit log**.

- **Usage:** every minute something is playing (not paused) adds a minute to that account and that show (series are counted
  by show, channels in Aurora's own live player as "Live: name"). 62 days are kept in `limits.json`.
- **Sharing:** the guard remembers the *network* (first three parts of an address) each account plays from, for 14 days.
  "Likely shared" = playing from two networks outside the home at the same moment for `sharingSimultaneousMinutes` minutes
  in a week (default 10); "Worth a look" = `sharingNetworks` or more networks in a week (default 4). Addresses inside the house count as one.
  It never signs anyone out by itself; the device limit does that.
- **Server health:** processor, memory, free disk space and streams (converting vs direct), one point a minute for 24 hours
  (kept in memory). List the drives to watch in `diskPaths`, for example `["D:\\", "E:\\"]`; an alert goes to `alertWebhookUrl`
  when one has less than `diskAlertPercent` free (default 10). Free space needs Node 18.15 or newer.
- **Audit log:** each change made through the admin endpoints is written with the admin's name (sent by the app) and the time;
  the last 500 are kept.

## Live TV: "is it just me?" (guard 1.7.0)

When a channel stops loading, the Aurora player tells the guard (an automatic "Channel is down" report, once per channel; not
when the provider is only refusing extra connections) and asks how many other people reported it in the last hour. It shows
the answer under the message. So that one bad connection doesn't look like a dead channel, an automatic "Channel is down"
report is **not** passed to the TV provider until a second person reports the same channel within the hour (it shows as
"waiting for a second person" in Admin → Channel reports).

## Sports scores (guard 1.8.0)

The Sports tab (Live TV → Sports) lists games found in the channel guide. The guard adds **live scores and the day's schedule** from
ESPN's public scoreboard feed (NFL, NBA, MLB, NHL, college football and basketball, the big soccer leagues, UFC and Formula 1), kept in
memory and refreshed every minute while a league has a live game (every ten minutes otherwise), so the apps never call the feed
themselves. **This feed is not an official, documented service:** ESPN can change or stop it at any time (the tab then falls back to the
channel guide on its own), and its terms haven't been confirmed for use in an app like this, so it is your call to keep it on.

- Check it works from the PC: `node aurora-guard.js --test-scores` (one line per league).
- Switch it off: `"scoresEnabled": false` in `config.json`, or untick it in Admin → Sports (which also picks the leagues).
- `"scoresBase"` points at another server with the same shape if you use a different provider later.
- **Admin → Sports → Name aliases** tells Aurora that two spellings are the same ("Man City" means "Manchester City", "SNF" means
  "Sunday Night Football"). Games are matched to channels by team name in the guide, then by the TV network the feed names.
- **Reminders** are kept on the customer's account and as notifications on their phone (the Android app); the guard isn't involved.

## Subscription plans (guard 1.5.0)

Admin → **Plans** holds the plans you sell. Each has a name, a price, a length (months or days), a number of **connections**
(devices in use at once) and either all Live TV categories or only the ones you tick. Two starters are added the first time
the guard 1.5.0 runs: **1 Month · 2 Connections ($35)** and **2 Months · 4 Connections ($55)**; add the rest yourself.

Put a plan on a customer in Admin → Users → the customer → **Subscription**, when you create the user, or by approving their
renewal request. One step sets their device limit, their end date (added after the time they have left, or from today, as you
choose), their Live TV categories, and switches the account back on if it had expired. You can charge a different price for
one person (say a discount); the price paid is what goes in the history. Admin → Plans shows what came in this month and last,
and each subscription. Aurora **records** prices; it doesn't take payments.

A customer's plan is a copy: changing or deleting a plan later doesn't change what someone already has. Changing a limit or date
by hand keeps their plan and categories. On the customer's side, Settings → My account shows the plan, and the renewal request
lets them say which plan they want (shown to you, with the price). The categories a plan includes limit what the customer's app
lists; they don't hide the provider's own address from someone who has it.

## Plan details and extension requests (guard 1.4.0)

Settings → **My account** shows each customer their plan: how many devices can be in use at once (the limit set in
Admin → Users), how many are in use now, and the date their access ends, with a **Request an extension** button
(with an optional note on phones). The request appears in Admin → Overview (a banner) and Admin → Users, where you pick
how long to add (7 days to a year) and **Approve** or **Deny**. Approving adds the time to whichever is later, today or
the current end date, so time already paid for is never lost, and switches the account back on if the guard had
switched it off. If `alertWebhookUrl` is set, a new request also sends you an alert. A customer sees "requested",
"approved until ..." or "not approved" in Settings. Nothing new is needed in `config.json`.

An account that has already expired is switched off in Emby, so its owner can't sign in to ask: they need to contact you.
The button is for the days before the end.

## TV provider connections (guard 1.3.0)

Your TV provider (restream) account allows a set number of streams at once; past that every new channel fails, which
looks just like buffering. Every minute the guard counts the streams in use: channels playing in Aurora's own live player
(each device notes its channel in the viewer's Emby settings) plus Emby's own Live TV sessions. Admin → Overview →
**TV provider connections** shows the count, who is using them and today's peak. Enter the number of connections on your
account and a warning level there (for example 60 and 50) and the guard sends an alert to `alertWebhookUrl` when the count
reaches the warning level, and an urgent one when it's full. Each alert is sent once, and again only after the count has
dropped back. Nothing new is needed in `config.json`; the two numbers are kept in `data/limits.json`.

## Alerts, live counts and the status page (guard 1.2.0)

**Alerts.** Put an address in `alertWebhookUrl` in `config.json` (blank = off) and the guard sends a short message when it:
- signs a device out, or switches off an expired account, **for real**. Nothing is sent in dry run. Actions in the same pass
  arrive as one message (at most 12 messages an hour);
- can't load its certificate (sent once, when the guard starts).

Examples: a Discord channel's webhook address (Edit channel → Integrations → Webhooks), or `https://ntfy.sh/your-secret-topic`
(then install the ntfy app and subscribe to that topic). Try it with `node aurora-guard.js --test-alert`. A webhook that is
down, slow or refuses the message never holds up or crashes the guard: the call has a 10-second limit, runs beside the
every-minute check, and a failure is only noted in `guard.log` (at most every 10 minutes). The address itself is never
written to the log, because it contains a secret.

**Live device counts (admins).** `GET /status/users` with an administrator's Emby token (`X-Emby-Token`, like the other
admin endpoints) returns, for every account with a saved limit or a device in use now: its `limit`, `activeDevices` (distinct
devices active in the last `activeWindowMinutes`), `over` (true if more than the limit), the devices, `disabled`/`expires`,
plus `totals`, `dryRun`, the last check, and whether Emby was reachable. Administrators aren't listed (they're never limited).

**Status page (public).** `https://your-address:8922/status` needs no login and shows only two lines:

```
Guard: online
Aurora: online
```

Aurora's Settings page shows customers the same thing as a simple "Aurora: Online / Offline" (guard 1.3.1 or later, which
lets the app read this page; with an older guard, or when the guard can't be reached, the app asks the Emby server instead).

`Aurora` is `online` when the guard's last every-minute check reached Emby with the configured API key (and that check
is recent), otherwise `offline`. For a few seconds after the guard starts it says `checking...`. If the page doesn't
load at all, the guard itself isn't running or can't be reached (for example a certificate problem).

**Which version is running?** `https://your-address:8922/health`, the first line of `node aurora-guard.js --check`, and
the "Aurora Guard 1.5.0 listening…" line in `guard.log` all show it. All of this is backward compatible: a `config.json` with
none of the new settings works exactly as before.

## Channel reports and the TV provider's API (guard 1.1.0)

Customers can report a channel (long-press it on a phone, or press Menu on a TV remote), and Aurora reports a channel by
itself when it keeps buffering. The guard keeps the reports for **Admin → Channel reports** and, if you switch it on
there, passes each one to your TV provider's API.

- **Set it up in Aurora, not in a file:** Admin → Channel reports → the provider's address, how the key is sent
  (header, Bearer, or in the address), the key, and (if the provider needs a particular layout) the body.
  "Send a test report" tries it.
- **The key is write-only.** It is stored in `data\provider.json` on this PC (the folder is limited to
  Administrators). It is never sent to any app: Admin shows only whether a key is set and its last 4 characters.
  To change it, type a new one and Save; "Remove the key" deletes it.
- **Limits:** one report per customer per channel every 10 minutes, and 30 reports an hour per customer.
- **Update the guard:** copy the new `aurora-guard.js` over the old one and restart the task. Older guards don't have
  these endpoints, and the Channel reports tab says so.

## Files

- `data\limits.json`: the store. Back it up if you like; it is rewritten safely, so a crash never leaves
  half a file.
- `data\guard.log`: what it did. It rolls over at 2 MB.

## Certificate problems

If the `.pfx` can't be loaded, the guard never falls back to plain http (admin tokens would cross the internet
unencrypted). It writes **`CERTIFICATE PROBLEM: the https endpoint is NOT running.`** and the reason to
`data\guard.log` (repeated every 10 minutes), and carries on with the every-minute check using the limits
already saved, unless `exitOnCertError` is `true`. Aurora can't reach the guard until it is fixed.

| The log says | Fix |
|---|---|
| uses an older encryption (RC2 / 3DES) | Start with `--openssl-legacy-provider` (the installer does), or re-export the `.pfx` with modern encryption: `openssl pkcs12 -legacy -in old.pfx -nodes -out all.pem` then `openssl pkcs12 -export -in all.pem -out new.pfx` (OpenSSL comes with Git for Windows) |
| the password is wrong | Fix `pfxPassphrase` in `config.json` |
| the file doesn't exist | Fix `pfxPath`. In JSON every backslash is doubled: `"C:\\certs\\emby.pfx"`, or use forward slashes |
| can't be read by the account the guard runs as | The task runs as SYSTEM, which can't open files in a user's own folders. Copy the `.pfx` into this folder and point `pfxPath` at the copy |
| Port ... is already in use | Another copy of the guard (or another program) has the port. Change `port`, or stop the other one |

To test the settings without installing anything: `node --openssl-legacy-provider aurora-guard.js --check`.
It prints `OK`, `WARNING` or `PROBLEM` lines and exits with 0 (fine), 1 (fix something) or 2 (only a warning:
Emby couldn't be reached).

## "Device limit check skipped: Not signed in"

That line in a customer's app log means the guard answered `/check` with "not signed in": it could not confirm the
customer's token with Emby. The check is only a courtesy message, so the customer is not affected, and the guard still
enforces on the server. `data\guard.log` now says why (`Not signed in (/check): ...`, at most once a minute): Emby refused
the token (the device was signed out, or the token is old), or answered for a different account. From version 1.0.1
the guard sends a customer's token to Emby without its own device name, which some Emby versions refused. Update the
PC's copy of `aurora-guard.js` and restart the task to get it.

## Stopping the guard

In PowerShell as Administrator:

```powershell
Stop-ScheduledTask -TaskName 'Aurora Guard'
Disable-ScheduledTask -TaskName 'Aurora Guard'
```

While it is stopped nothing is enforced: no device limits and no expiration dates. Accounts it disabled for
expiry stay disabled until you enable them in Emby (or in Aurora → Admin → Users). Devices it signed out have
to sign in again. To start it again: `Enable-ScheduledTask -TaskName 'Aurora Guard'; Start-ScheduledTask -TaskName 'Aurora Guard'`.


## Resellers (guard 1.10.0)

A reseller is an Emby account (non-administrator) that you have given credits. They sign in to Aurora as usual and open **Reseller panel**
in the profile menu. Credits pay for the plans they sell: **a plan costs its "Reseller credits" (Admin → Plans), or, if that is left blank,
connections × months** (one credit = one connection for one month). A free 2-day trial costs nothing (up to `resellerTrialsPerDay`, default 5, a day).

- **Add one:** Admin → Resellers → Add a reseller (name, login, optional password, starting credits, plans they may sell). The login is created in Emby.
- **Credits:** Admin → Resellers → Credits: Add, Remove or Set to, with a reason. Every change is in the ledger and in Admin → Audit log.
- **What a reseller can do:** create customers (username, password, name, email, phone, note), renew them, edit details, reset a password, sign devices out.
  They can only touch customers they created; they cannot open any other admin page or see other resellers. A suspended reseller can do nothing; their customers keep working.
- **Safety:** one change at a time per reseller (no double-spending), the balance can't go below zero, usernames are checked, the Emby password is set before credits are taken.
- **Config (optional, in config.json):** `"resellerLowCredits": 3` (warn at or under this), `"resellerTrialsPerDay": 5`.
- New customers also get the Aurora settings the first administrator has (Live TV source, Requests, update lock, playback).

## Notifications, announcements, support, referrals (guard 1.11.0)

- **Bell:** every customer gets an inbox: announcements you send, "your plan ends in 7 / 3 / 1 days" with an **Ask for more time** button (this is the
  existing extension request), new titles added in the last week, and replies from support. Admins see their Admin inbox count on the bell instead.
- **Announcements:** Admin → Customers → Announcements. A banner at the top of the app and an entry in the bell. **Info** notices can be dismissed; **Warnings and Outages stay** until they expire or you remove them (customers can't dismiss them; admins can).
  Send to everyone, one plan or one reseller's customers; it disappears after the time you choose.
- **Help & support:** Settings → Help & support. The customer's message arrives in Admin → Support with the diagnostics attached.
- **Refer a friend:** each customer has a code. Config keys (optional): `"referralDays": 7` (0 switches it off) and `"referralMaxPerYear": 10`.
  Free days are added to both end dates; accounts with no end date get nothing to add.
- **Resellers:** Needs renewing list with bulk renew and copyable reminder messages, a monthly report, and **Request credits**
  (approve in Admin → Inbox).

## Maintenance mode (guard 1.12.0)

Admin → Server → **Maintenance mode**: tick the parts you are working on (Movies, TV Shows, Favorites, Live TV, Sports, Requests, Downloads), write a message (blank uses
a friendly default) and an optional "back around" note, and Save. Customers see a "We'll be right back!" page there, can't open the titles or channels inside, and a
wrench marks the tab. You (administrators) always keep full access. It reaches open apps within about two minutes and applies at once when Aurora opens.
This is done by the Aurora app: another Emby app talking to the server directly is not stopped by it.

## Reseller panel updates (guard 1.13.0)

- **Customer list:** search (name, username, email, phone, note, plan), filter (Active, Ending soon, Expired, Trial, On hold), sort, and export (copy / .csv).
- **Renew with any plan** the reseller may sell; **reset password** shows a welcome message to send; **hold** switches a customer's sign-in off (devices are signed
  out, the end date keeps running, and a renewal does not release it); **delete** removes the customer's Emby account (credits are not refunded).
- **Announcements** now reach resellers too, on their panel (Warnings and Outages stick, Info can be dismissed). New audiences: **All resellers**, and a
  reseller also sees what is sent to "one reseller's customers" for their own customers.

## Speed test (guard 1.14.0)

Settings → **Speed test** measures the connection to the Aurora server: ping (10 small requests, with lost replies counted), download (the server's own
bitrate-test address, about 7 seconds) and upload (about 6 seconds of data sent to the guard). It says in plain words what the connection can handle (Live TV,
1080p, 4K), suggests a video quality (**Use it** sets Streaming quality), keeps the last 5 results on the device, and can send the result to support, where it
shows in Admin → Support. Auto quality also starts from what was just measured. About 30 to 60 MB of data is used. With an older guard the upload part is skipped.

## Hardening (guard 1.15.1)

- A crash in one background job or request is logged and the guard carries on (`uncaughtException` / `unhandledRejection` handlers).
- Connections that start a request and never finish it are closed after 15 seconds (headers) / 2 minutes (whole request); bad requests get a 400.
- `/limits/__proto__`, `/limits/constructor` and similar special names are refused with 400 instead of being stored as accounts.
- A request body over 64 KB now gets a clean 400 "too large" instead of a dropped connection.
- Saving `limits.json` retries a few times when Windows (antivirus, backup) holds the file for a moment.

## Website sign-up and discount codes (guard 1.16.0)

Used by the `website/` folder. Public (no sign-in): `GET /site/info` (prices, whether sign-up is open), `GET /discount/check?code=`, `POST /signup`, `POST /admin-login` (an Emby administrator's username and password, answers with a token). Admin: `GET/POST /discounts`, `PUT/DELETE /discounts/CODE`. Sign-up is off until `"signupEnabled": true` is in `config.json` (also `signupTrialDays`, `signupTrialConnections`, `signupMaxPerDay`, `signupPerIpPerDay`). See `website/README.md`.

Guard 1.16.1 adds `POST /site-login` (any Emby account; answers with the token and whether it is an administrator or a reseller), used by the website's reseller page.

## Updating the guard (guard 1.17.0)

Admin → Server has an **Aurora Guard** card. The guard looks for a newer version in the Aurora releases on GitHub once a day (and when you press Check again). When there is one it shows what changed and an **Update now** button. Nothing is installed until an administrator taps it.

Tapping Update now: the guard downloads `aurora-guard.js`, compares it with the checksum published in `aurora-guard.json` (same release), checks it is a newer version, tries it (`--check`: the certificate, the Emby key and the code have to load on this PC), keeps the current file in `backups/` (the last six are kept), replaces the file and restarts itself. If any step fails nothing is changed and Discord is told why. **Go back** puts the kept version back.

- First time: copy this version of `aurora-guard.js` to the PC by hand and restart the task; after that the button does it.
- Only https downloads from GitHub's own addresses are accepted. `"updateCheck": false` stops the daily look; `"updateRepo"` points it at a different repository.
- Every push that changes `server/` publishes a release carrying the guard file (`.github/workflows/aurora-apk.yml`), so a guard-only change also builds the app; the version number in `aurora-guard.js` (`VERSION`) must go up for the guard to offer it.

### Keep-alive

`node aurora-guard.js` now runs as two processes: a small watcher and the real guard. The watcher restarts the guard after an update and also if it ever crashes (after 5 seconds; it gives up after 8 stops in 10 minutes so a real problem stays visible). Stopping the watcher (Stop-ScheduledTask, Ctrl+C, `systemctl stop`) stops the guard too. `--check`, `--test-alert` and `--test-scores` run directly, and `AURORA_GUARD_SUPERVISE=0` turns the watcher off.

## Daily summary (guard 1.18.0)

Each morning the guard sends one message about the day before to the alert webhook (`alertWebhookUrl`): hours watched, viewers, the most streams at once and the TV provider peak, the most watched titles, new sign-ups, plans put on accounts (and the amount), free trials, devices signed out, accounts switched off, channels people reported, whether Emby was reachable, free disk space, and a **Needs attention** list first when something is waiting (accounts ending within a week, support messages, credit and extension requests, resellers low on credits, low disk space). A Discord webhook gets an embed (green for a quiet day, blue normal, amber when something needs you, red when Emby was down or the disk is low); other webhook kinds get the same facts as text. It does not count toward the 12-alerts-an-hour limit.

- On whenever `alertWebhookUrl` is set. In `config.json`: `"dailySummary": false` switches it off, `"dailySummaryHour": 8` sets the hour (the PC's clock), `"dailySummaryMoney": false` leaves the plans-sold amount out.
- The first message comes the day after the guard first runs with it. If the PC was off at the hour, it is sent when the guard next starts that day (once a day); a failed send is tried again after 10 minutes.
- `node --openssl-legacy-provider aurora-guard.js --test-summary` sends yesterday's summary now; Admin → Server has a **Send one now** button (`POST /summary/send`, `GET /summary`).
- It is built from what the guard already keeps (usage, sign-ups, plans, actions, reports, server checks). Peaks are recorded from 1.18.0 on, so the first days may show 0 streams.

## Fixes in 1.18.1

- A paid plan put on a website trial account now ends the trial (it kept showing "Free trial" and could not use or give referral codes).
- Referral codes: a free trial account cannot use a code or be the friend whose code is used, and the first 14 days now start when an account is first seen (they could not be checked before for accounts the guard had no record of).
- A server error from Emby (5xx) while checking who is an administrator no longer counts as "not an administrator".
- Signing in to the admin page with a non-administrator account no longer leaves a signed-in session behind.
- A change to the guard alone (`server/**`) is published by its own workflow as a guard-only release. It does not build a new app, so the phone and TV apps are not asked to update.
