package com.johnny4091.embyflix;

import android.content.Context;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Fetches channel lists from the TV provider (M3U playlists and Xtream channel lists) for the page:
 * <ul>
 *   <li>follows redirects, including between http and https, which Java won't do on its own;</li>
 *   <li>keeps the last good copy, so a provider hiccup doesn't empty Live TV (the page is told it's an older copy);</li>
 *   <li>for M3U, keeps only live channels: many playlists also list thousands of movies and series;</li>
 *   <li>hands the text over in pieces (open / read), rather than as one huge message.</li>
 * </ul>
 */
final class IptvFetcher {
    private static final int MAX_REDIRECTS = 5;
    /** Movies and series in an M3U playlist: Xtream-style /movie/ and /series/ addresses, or video files. */
    private static final Pattern NOT_LIVE = Pattern.compile("(?i)(/movie/|/series/|\\.(mp4|mkv|avi|mov|wmv|flv|m4v|webm)(\\?|$))");

    private static final Map<Integer, Reader> readers = new HashMap<>();
    private static int nextHandle = 1;

    private IptvFetcher() {}

    /**
     * Makes the text at url available. maxAgeMs > 0 reuses a saved copy that young without asking the provider;
     * allowStale lets a failed request fall back to an older saved copy. Returns
     * {"status": http status (0 = couldn't connect), "stale": true if an older copy is being used, "error": "..."}.
     */
    static JSONObject fetch(Context context, String url, String userAgent, long maxAgeMs, boolean allowStale,
                            boolean liveOnly, int timeoutMs) {
        JSONObject result = new JSONObject();
        try {
            File file = cacheFile(context, url, liveOnly);
            // Older versions could have saved a provider's error page as the list; never reuse one.
            if (file.exists() && webPage(file) != null) file.delete();
            boolean have = file.exists() && file.length() > 0;
            if (have && maxAgeMs > 0 && System.currentTimeMillis() - file.lastModified() < maxAgeMs) {
                return result.put("status", 200).put("stale", false).put("cached", true);
            }
            int status;
            String error = null;
            try {
                status = download(url, userAgent, timeoutMs, file, liveOnly);
            } catch (IOException e) {
                status = 0;
                error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            }
            if (status >= 200 && status < 300) return result.put("status", status).put("stale", false);
            if (allowStale && have) {
                return result.put("status", 200).put("stale", true).put("error", error == null ? "status " + status : error);
            }
            result.put("status", status);
            if (error != null) result.put("error", error);
            return result;
        } catch (Exception e) {
            try { return result.put("status", 0).put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { return result; }
        }
    }

    /** Opens the saved text for reading in pieces; returns a handle, or 0 if there's nothing saved. */
    static synchronized int open(Context context, String url, boolean liveOnly) {
        try {
            File file = cacheFile(context, url, liveOnly);
            if (!file.exists()) return 0;
            int handle = nextHandle++;
            readers.put(handle, new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8), 65536));
            return handle;
        } catch (IOException e) {
            return 0;
        }
    }

    /** The next piece of up to maxChars characters, or "" at the end (which also closes the handle). */
    static String read(int handle, int maxChars) {
        Reader r;
        synchronized (IptvFetcher.class) { r = readers.get(handle); }
        if (r == null) return "";
        try {
            char[] buf = new char[Math.max(1024, Math.min(maxChars, 4 << 20))];
            int n = r.read(buf);
            if (n > 0) return new String(buf, 0, n);
        } catch (IOException ignored) {
            // Treated as the end.
        }
        close(handle);
        return "";
    }

    static void close(int handle) {
        Reader r;
        synchronized (IptvFetcher.class) { r = readers.remove(handle); }
        try { if (r != null) r.close(); } catch (IOException ignored) { /* nothing to do */ }
    }

    private static File cacheFile(Context context, String url, boolean liveOnly) throws IOException {
        File dir = new File(context.getCacheDir(), "iptv");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("no cache folder");
        return new File(dir, Integer.toHexString(url.hashCode()) + (liveOnly ? ".live" : "") + ".txt");
    }

    /** If the file is a web page rather than a channel list or provider data: what to tell the viewer. Otherwise null. */
    static String webPage(File f) {
        byte[] head = new byte[4096];
        int n = 0;
        try (InputStream in = new java.io.FileInputStream(f)) {
            for (int r; n < head.length && (r = in.read(head, n, head.length - n)) > 0; ) n += r;
        } catch (IOException e) {
            return null;
        }
        String start = new String(head, 0, n, java.nio.charset.StandardCharsets.UTF_8).replace("\uFEFF", "").trim();
        String lower = start.toLowerCase(java.util.Locale.ROOT);
        if (!lower.startsWith("<!doctype html") && !lower.startsWith("<html") && !(lower.startsWith("<") && lower.contains("<body"))) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("<title[^>]*>([^<]{1,120})", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(start);
        return "The TV provider sent a web page instead of the channels" + (m.find() ? " (\"" + m.group(1).trim() + "\")" : "")
                + ". The provider may be blocking this internet connection, or the account may be busy or expired.";
    }

    /** Downloads url into file (through a temporary file, so a failed download never spoils the saved copy). */
    private static int download(String url, String userAgent, int timeoutMs, File file, boolean liveOnly) throws IOException {
        HttpURLConnection conn = null;
        File tmp = new File(file.getPath() + "." + Thread.currentThread().getId() + ".part");
        try {
            String at = url;
            int status;
            for (int hop = 0; ; hop++) {
                if (!at.startsWith("http://") && !at.startsWith("https://")) throw new IOException("unsupported address");
                conn = (HttpURLConnection) new URL(at).openConnection();
                conn.setConnectTimeout(Math.min(timeoutMs, 20000));
                conn.setReadTimeout(Math.max(timeoutMs, 30000));
                conn.setInstanceFollowRedirects(false);
                if (userAgent != null && !userAgent.isEmpty()) conn.setRequestProperty("User-Agent", userAgent);
                status = conn.getResponseCode();
                if (status >= 300 && status < 400 && hop < MAX_REDIRECTS) {
                    String next = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (next == null) throw new IOException("the provider redirected nowhere");
                    at = new URL(new URL(at), next).toString();
                    continue;
                }
                break;
            }
            if (status >= 300) return status;
            try (InputStream in = conn.getInputStream()) {
                if (liveOnly) writeLiveOnly(in, tmp);
                else {
                    try (OutputStream out = new FileOutputStream(tmp)) {
                        byte[] buf = new byte[65536];
                        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                    }
                }
            }
            if (tmp.length() == 0) throw new IOException("the provider sent back nothing");
            // An error, block or "too many connections" page sent as if all was well: never save it over the good copy.
            String page = webPage(tmp);
            if (page != null) throw new IOException(page);
            if (!tmp.renameTo(file)) throw new IOException("couldn't save the list");
            return status;
        } finally {
            tmp.delete();
            if (conn != null) conn.disconnect();
        }
    }

    /** Copies an M3U playlist, leaving out movies and series. Each entry is #EXTINF (+ other # lines) + address. */
    private static void writeLiveOnly(InputStream in, File out) throws IOException {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8), 65536);
             BufferedWriter w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(out), StandardCharsets.UTF_8), 65536)) {
            StringBuilder entry = new StringBuilder();
            for (String line; (line = r.readLine()) != null; ) {
                String t = line.trim();
                if (t.isEmpty()) continue;
                if (t.startsWith("#EXTM3U")) { w.write(t); w.write('\n'); continue; }
                if (t.startsWith("#")) {
                    if (t.toUpperCase(Locale.ROOT).startsWith("#EXTINF")) entry.setLength(0);
                    entry.append(t).append('\n');
                    continue;
                }
                // An address ends the entry.
                if (!NOT_LIVE.matcher(t).find()) {
                    w.write(entry.toString());
                    w.write(t);
                    w.write('\n');
                }
                entry.setLength(0);
            }
        }
    }
}
