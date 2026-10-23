package com.johnny4091.embyflix;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Tells the Emby server which live channel (M3U / Xtream) this device is playing, so the admin can see it in
 * Aurora's Admin pages. These streams come straight from the TV provider, so Emby wouldn't know otherwise.
 *
 * It's kept in the viewer's own Emby display preferences ("aurora-watching", client "aurora"):
 * {"devices": {deviceId: {name, num, logo, group, now, device, started, at}}, "history": [{name, num, group, device, started, ended}]}
 * The entry is refreshed every minute while playing and removed when the player closes; the admin page treats
 * an entry not refreshed for three minutes as stopped (a device that lost power, say).
 */
final class LiveReporter {
    private static final String PREFS = "aurora-watching";
    private static final int HISTORY = 30;

    private final String base, apiKey, userId, deviceId, device, auth;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private JSONObject current;   // what's playing (touched on the worker thread only)
    private long started;

    private LiveReporter(JSONObject r) {
        base = r.optString("base");
        apiKey = r.optString("apiKey");
        userId = r.optString("userId");
        deviceId = r.optString("deviceId");
        device = r.optString("device");
        auth = r.optString("auth");
    }

    /** From the page's report details; null if there are none (then nothing is reported). */
    static LiveReporter from(String json) {
        try {
            if (json == null || json.isEmpty()) return null;
            JSONObject r = new JSONObject(json);
            if (r.optString("base").isEmpty() || r.optString("userId").isEmpty() || r.optString("deviceId").isEmpty()) return null;
            return new LiveReporter(r);
        } catch (Exception e) {
            return null;
        }
    }

    /** A channel started (or the viewer switched to it). */
    void playing(String name, String num, String logo, String group, String now) {
        long at = System.currentTimeMillis();
        if (worker.isShutdown()) return;
        worker.execute(() -> {
            try {
                JSONObject entry = new JSONObject().put("name", name).put("num", num).put("logo", logo)
                        .put("group", group).put("now", now).put("device", device);
                write(entry, true, at);
            } catch (Exception ignored) {
                // Reporting is best effort.
            }
        });
    }

    /** Still watching: refreshes the entry so the admin page knows it's live. */
    void heartbeat() {
        if (worker.isShutdown()) return;
        worker.execute(() -> {
            if (current == null) return;
            try { write(current, false, System.currentTimeMillis()); } catch (Exception ignored) { /* best effort */ }
        });
    }

    /** The player closed: remove this device's entry and add the last channel to the history. */
    void stopped() {
        if (worker.isShutdown()) return;
        worker.execute(() -> {
            try { write(null, false, System.currentTimeMillis()); } catch (Exception ignored) { /* best effort */ }
        });
    }

    /** No more reports (the player is gone). Anything already queued still goes out. */
    void close() {
        worker.shutdown();
    }

    /**
     * Two devices on one account share this one setting and each saves the whole thing, so they can overwrite each
     * other's entry when both save within the same moment. So after saving, look again: if this device's entry is
     * missing (or, when closing, still there) save once more after a short random wait. Up to 3 tries.
     */
    private void write(JSONObject entry, boolean newChannel, long now) throws Exception {
        for (int attempt = 0; attempt < 3; attempt++) {
            writeOnce(entry, attempt == 0 && newChannel, attempt == 0 ? now : System.currentTimeMillis());
            if (saved(entry)) return;
            try { Thread.sleep(200 + (long) (Math.random() * 600)); } catch (InterruptedException e) { return; }
        }
    }

    /** Is this device's entry in the saved setting as it should be? (A failed read counts as fine: nothing to compare.) */
    private boolean saved(JSONObject entry) {
        try {
            JSONObject custom = read().optJSONObject("CustomPrefs");
            JSONObject data = new JSONObject(custom == null ? "{}" : custom.optString("config", "{}"));
            JSONObject devices = data.optJSONObject("devices");
            JSONObject mine = devices == null ? null : devices.optJSONObject(deviceId);
            return entry == null ? mine == null : mine != null && mine.optLong("at") == entry.optLong("at");
        } catch (Exception e) {
            return true;
        }
    }

    private void writeOnce(JSONObject entry, boolean newChannel, long now) throws Exception {
        JSONObject prefs = read();
        JSONObject custom = prefs.optJSONObject("CustomPrefs");
        if (custom == null) custom = new JSONObject();
        JSONObject data;
        try { data = new JSONObject(custom.optString("config", "{}")); } catch (Exception e) { data = new JSONObject(); }
        JSONObject devices = data.optJSONObject("devices");
        if (devices == null) devices = new JSONObject();
        JSONArray history = data.optJSONArray("history");
        if (history == null) history = new JSONArray();

        // What was playing before ends now (a new channel, or the player closing).
        if ((newChannel || entry == null) && current != null) {
            JSONObject done = new JSONObject().put("name", current.optString("name")).put("num", current.optString("num"))
                    .put("group", current.optString("group")).put("device", device).put("started", started).put("ended", now);
            // Channel surfing (under a minute) isn't worth remembering.
            if (now - started >= 60_000) {
                JSONArray h = new JSONArray().put(done);
                for (int i = 0; i < history.length() && h.length() < HISTORY; i++) h.put(history.get(i));
                history = h;
            }
        }
        if (entry == null) {
            devices.remove(deviceId);
            current = null;
        } else {
            if (newChannel) started = now;
            current = entry;
            entry.put("started", started).put("at", now);
            devices.put(deviceId, entry);
        }
        // Tidy away devices that stopped reporting long ago.
        for (Iterator<String> it = devices.keys(); it.hasNext(); ) {
            String k = it.next();
            JSONObject d = devices.optJSONObject(k);
            if (d == null || now - d.optLong("at") > 12 * 3600_000L) it.remove();
        }
        data.put("devices", devices).put("history", history);
        custom.put("config", data.toString());

        JSONObject body = new JSONObject()
                .put("Id", PREFS).put("Client", "aurora").put("SortBy", "SortName").put("SortOrder", "Ascending")
                .put("RememberIndexing", false).put("RememberSorting", false).put("ScrollDirection", "Horizontal")
                .put("ShowBackdrop", false).put("ShowSidebar", false).put("PrimaryImageHeight", 0).put("PrimaryImageWidth", 0)
                .put("CustomPrefs", custom);
        request("POST", body.toString());
    }

    private JSONObject read() throws Exception {
        String text = request("GET", null);
        return text == null || text.isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private String request(String method, String body) throws Exception {
        String url = base + "/DisplayPreferences/" + PREFS + "?userId=" + enc(userId) + "&client=aurora&api_key=" + enc(apiKey);
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Accept", "application/json");
            if (!auth.isEmpty()) conn.setRequestProperty("X-Emby-Authorization", auth);
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = conn.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
            }
            int status = conn.getResponseCode();
            if (status >= 400) throw new java.io.IOException("Emby answered " + status);
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                return out.toString("UTF-8");
            }
        } finally {
            conn.disconnect();
        }
    }

    private static String enc(String s) throws Exception { return URLEncoder.encode(s, "UTF-8"); }
}
