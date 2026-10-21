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
| `GET /connections`, `PUT /connections` | Emby administrators | TV provider streams in use now, today's peak, and `{limit, alertAt}` for the alerts. |
| `GET /limits`, `GET /actions` | Emby administrators | Reads the store and the recent actions. |
| `PUT /limits/{userId}` | Emby administrators | Sets `{limit, expires: "YYYY-MM-DD" or null}` and applies it at once. |
| `DELETE /limits/{userId}`, `PUT /limits/{userId}/manual`, `PUT /migrated` | Emby administrators | Housekeeping. |

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

`Aurora` is `online` when the guard's last every-minute check reached Emby with the configured API key (and that check
is recent), otherwise `offline`. For a few seconds after the guard starts it says `checking...`. If the page doesn't
load at all, the guard itself isn't running or can't be reached (for example a certificate problem).

**Which version is running?** `https://your-address:8922/health`, the first line of `node aurora-guard.js --check`, and
the "Aurora Guard 1.3.0 listening…" line in `guard.log` all show it. All of this is backward compatible: a `config.json` with
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
