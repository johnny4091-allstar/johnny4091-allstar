# Aurora Guard

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

   This makes it start with Windows and restart if it stops, opens the port in Windows Firewall, and limits
   the folder to Administrators.
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
| `intervalSeconds` | How often it checks (default 60, minimum 20) |
| `activeWindowMinutes` | A device counts as in use if it talked to Emby this recently (default 5) |
| `defaultLimit` | Device limit for accounts without their own (default 2) |
| `dryRun` | `true`: only log what it would do |

## Endpoints

| Endpoint | Who can call it | What it does |
|---|---|---|
| `GET /health` | Anyone | Says the guard is running. No data. |
| `GET /check?userId=&deviceId=&phase=` | The signed-in user, about themselves | Returns whether Aurora should let them in or play, with a message. This is only so Aurora can explain up front; it doesn't enforce anything. |
| `GET /limits`, `GET /actions` | Emby administrators | Reads the store and the recent actions. |
| `PUT /limits/{userId}` | Emby administrators | Sets `{limit, expires: "YYYY-MM-DD" or null}` and applies it at once. |
| `DELETE /limits/{userId}`, `PUT /limits/{userId}/manual`, `PUT /migrated` | Emby administrators | Housekeeping. |

## Files

- `data\limits.json`: the store. Back it up if you like; it is rewritten safely, so a crash never leaves
  half a file.
- `data\guard.log`: what it did. It rolls over at 2 MB.
