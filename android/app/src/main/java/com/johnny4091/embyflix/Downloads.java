package com.johnny4091.embyflix;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.StatFs;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Iterator;

/**
 * Offline downloads. A movie or episode is saved to the app's own folder with Android's DownloadManager, which keeps going in
 * the background, waits for Wi-Fi when asked, retries, and shows its own notification. The page keeps asking {@link #list} for
 * progress. A finished file is played by the normal player from its file:// address. Nothing here can reach other apps' files.
 */
public final class Downloads {
    private static final String PREFS = "aurora-downloads";

    private Downloads() { }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject load(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("all", "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void save(Context ctx, JSONObject all) {
        prefs(ctx).edit().putString("all", all.toString()).apply();
    }

    private static String safe(String s) {
        return s == null ? "x" : s.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private static File folder(Context ctx) {
        File base = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (base == null) return null;
        File dir = new File(base, "aurora");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private static File fileFor(Context ctx, String itemId, String ext) {
        File dir = folder(ctx);
        return dir == null ? null : new File(dir, safe(itemId) + "." + safe(ext));
    }

    /** Starts a download. Returns "" when it started, or a sentence for the customer. */
    static String start(Context ctx, String itemId, String url, String token, String title, String subtitle, String ext, boolean wifiOnly) {
        try {
            if (itemId == null || itemId.isEmpty() || url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return "That video can't be downloaded.";
            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return "Downloads are not available on this device.";
            JSONObject all = load(ctx);
            if (all.has(itemId)) return "That one is already downloaded or downloading.";
            File f = fileFor(ctx, itemId, ext == null || ext.isEmpty() ? "mp4" : ext);
            if (f == null) return "This device has no storage Aurora can use.";
            if (f.exists()) f.delete();
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                    .setTitle(title == null || title.isEmpty() ? "Aurora download" : title)
                    .setDescription("Aurora")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setAllowedOverMetered(!wifiOnly)
                    .setAllowedOverRoaming(false)
                    .setDestinationUri(Uri.fromFile(f));
            if (token != null && !token.isEmpty()) req.addRequestHeader("X-Emby-Token", token);
            long id = dm.enqueue(req);
            all.put(itemId, new JSONObject().put("dm", id).put("title", title).put("subtitle", subtitle).put("ext", ext == null || ext.isEmpty() ? "mp4" : ext)
                    .put("added", System.currentTimeMillis()));
            save(ctx, all);
            return "";
        } catch (Exception e) {
            return "Could not start the download: " + e.getMessage();
        }
    }

    /** [{itemId, title, subtitle, status: pending|running|paused|done|failed, bytes, total, added, url (when done), size}] */
    static String list(Context ctx) {
        JSONArray out = new JSONArray();
        try {
            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            JSONObject all = load(ctx);
            Iterator<String> keys = all.keys();
            while (keys.hasNext()) {
                String itemId = keys.next();
                JSONObject r = all.optJSONObject(itemId);
                if (r == null) continue;
                String status = "failed";
                long got = 0, total = 0;
                if (dm != null) {
                    Cursor cur = dm.query(new DownloadManager.Query().setFilterById(r.optLong("dm")));
                    if (cur != null) {
                        try {
                            if (cur.moveToFirst()) {
                                int st = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                                got = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                                total = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                                if (st == DownloadManager.STATUS_SUCCESSFUL) status = "done";
                                else if (st == DownloadManager.STATUS_RUNNING) status = "running";
                                else if (st == DownloadManager.STATUS_PAUSED) status = "paused";
                                else if (st == DownloadManager.STATUS_PENDING) status = "pending";
                            }
                        } finally {
                            cur.close();
                        }
                    }
                }
                File f = fileFor(ctx, itemId, r.optString("ext", "mp4"));
                if (status.equals("done") && (f == null || !f.exists() || f.length() == 0)) status = "failed";
                JSONObject o = new JSONObject().put("itemId", itemId).put("title", r.optString("title")).put("subtitle", r.optString("subtitle"))
                        .put("status", status).put("bytes", got).put("total", total).put("added", r.optLong("added"));
                if (status.equals("done") && f != null) o.put("url", Uri.fromFile(f).toString()).put("size", f.length());
                out.put(o);
            }
        } catch (Exception ignored) {
            // an empty or partial list is better than none
        }
        return out.toString();
    }

    static void remove(Context ctx, String itemId) {
        try {
            JSONObject all = load(ctx);
            JSONObject r = all.optJSONObject(itemId);
            if (r == null) return;
            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) dm.remove(r.optLong("dm"));
            File f = fileFor(ctx, itemId, r.optString("ext", "mp4"));
            if (f != null && f.exists()) f.delete();
            all.remove(itemId);
            save(ctx, all);
        } catch (Exception ignored) {
            // nothing to remove
        }
    }

    static void removeAll(Context ctx) {
        try {
            Iterator<String> keys = load(ctx).keys();
            java.util.ArrayList<String> ids = new java.util.ArrayList<>();
            while (keys.hasNext()) ids.add(keys.next());
            for (String id : ids) remove(ctx, id);
        } catch (Exception ignored) {
            // nothing to remove
        }
    }

    /** {used, free, total} in bytes for the folder downloads go to. */
    static String storage(Context ctx) {
        try {
            File dir = folder(ctx);
            if (dir == null) return "{}";
            long used = 0;
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) used += f.length();
            StatFs sf = new StatFs(dir.getPath());
            return new JSONObject().put("used", used).put("free", sf.getAvailableBytes()).put("total", sf.getTotalBytes()).toString();
        } catch (Exception e) {
            return "{}";
        }
    }
}
