package com.johnny4091.embyflix;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserFactory;

import java.io.BufferedInputStream;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.zip.GZIPInputStream;

/**
 * The XMLTV guide, kept by the app rather than the web page. Guides can be tens of megabytes; handing all of
 * that to the page was too much for TV boxes and phones. The app reads the guide once (streaming, plain or
 * gzipped), keeps the next few hours of every channel, saves that compactly, and the page asks for just the
 * channels it is showing (see lookup()).
 */
final class EpgLoader {
    /** How long a downloaded guide file is reused. */
    private static final long DOWNLOAD_MS = 6 * 3600_000L;
    /** How long the saved, read guide is used without looking for a newer one... */
    private static final long FRESH_MS = 4 * 3600_000L;
    /** ...and how long it's still used while a newer one is read in the background. Kept well inside AHEAD_MS,
     *  so an older saved guide still has the next six hours (the guide page's width) in it. */
    private static final long STALE_MS = 8 * 3600_000L;
    // The guide page shows six hours; 14 hours ahead covers a saved guide up to STALE_MS old.
    private static final long BEFORE_MS = 3600_000L, AHEAD_MS = 14 * 3600_000L;
    private static final int MAX_DESC = 180;
    private static final int MAX_REDIRECTS = 5;

    /** One channel in the guide: its name, logo, and programmes as a JSON array [[start, end, title, desc], ...]. */
    private static final class Entry {
        final String name, icon, progs;
        Entry(String name, String icon, String progs) { this.name = name; this.icon = icon; this.progs = progs; }
    }

    /**
     * A guide ready for lookups. Only an index is kept in memory (where each channel's line is in the saved
     * file); the listings stay on disk and are read for the channels asked about. Holding a big provider's
     * whole guide in memory made Android stop the app again and again to tidy memory, and everything lagged.
     * Replaced, never changed, so lookups from any thread are safe.
     */
    private static final class Guide {
        final String url;
        final long builtAt;
        final File file;
        final Map<String, long[]> lineById;     // key -> {offset, length} in file
        final Map<String, String> idByName;
        final int programmes;
        /** Opened once: a background refresh replaces the file, and this keeps reading the version indexed. */
        private final java.io.RandomAccessFile data;
        Guide(String url, long builtAt, File file, Map<String, long[]> lineById, Map<String, String> idByName, int programmes) throws IOException {
            this.url = url; this.builtAt = builtAt; this.file = file; this.lineById = lineById; this.idByName = idByName; this.programmes = programmes;
            this.data = new java.io.RandomAccessFile(file, "r");
        }

        synchronized Entry read(String key) {
            long[] at = lineById.get(key);
            if (at == null) return null;
            try {
                byte[] buf = new byte[(int) at[1]];
                data.seek(at[0]);
                data.readFully(buf);
                String[] parts = new String(buf, StandardCharsets.UTF_8).split("\t", 4);
                return parts.length < 4 ? null : new Entry(parts[1], parts[2], parts[3]);
            } catch (IOException e) {
                return null;
            }
        }
    }

    private static volatile Guide current;
    private static final Object loadLock = new Object();
    private static final Set<String> refreshing = new HashSet<>();

    private EpgLoader() {}

    /**
     * Makes the guide at url the current one, reading it if needed. Returns a short summary for the page:
     * {"channels": n, "programmes": n}. Slow only the first time; afterwards the saved copy loads in moments.
     */
    static String load(Context context, String url, String userAgent) throws Exception {
        synchronized (loadLock) {
            Guide g = current;
            long now = System.currentTimeMillis();
            if (g == null || !g.url.equals(url) || now - g.builtAt > STALE_MS) {
                g = readSaved(context, url);
                if (g == null || now - g.builtAt > STALE_MS) g = build(context, url, userAgent);
                current = g;
            }
            if (now - g.builtAt > FRESH_MS) refreshLater(context, url, userAgent);
            return summary(g);
        }
    }

    private static String summary(Guide g) {
        return "{\"channels\":" + g.lineById.size() + ",\"programmes\":" + g.programmes + "}";
    }

    /**
     * Guide entries for the channels the page is showing. request: [{"id": tvg-id, "name": channel name}, ...].
     * Returns a JSON array in the same order: {"n": name, "i": logo, "p": [[start, end, title, desc], ...]} or null.
     */
    static String lookup(String url, String requestJson) {
        Guide g = current;
        if (g == null || (url != null && !url.isEmpty() && !g.url.equals(url))) return "null";
        try {
            JSONArray req = new JSONArray(requestJson);
            StringBuilder out = new StringBuilder(req.length() * 256).append('[');
            for (int i = 0; i < req.length(); i++) {
                if (i > 0) out.append(',');
                JSONObject r = req.optJSONObject(i);
                Entry e = r == null ? null : find(g, r.optString("id", ""), r.optString("name", ""));
                if (e == null) { out.append("null"); continue; }
                out.append("{\"n\":").append(JSONObject.quote(e.name))
                        .append(",\"i\":").append(JSONObject.quote(e.icon))
                        .append(",\"p\":").append(e.progs).append('}');
            }
            return out.append(']').toString();
        } catch (Exception e) {
            return "null";
        }
    }

    /** How many of the given channels have listings and logos in the current guide: {"listings": n, "logos": n}. */
    static String count(String url, String requestJson) {
        Guide g = current;
        if (g == null || !g.url.equals(url)) return "{\"listings\":0,\"logos\":0}";
        int listings = 0, logos = 0;
        try {
            JSONArray req = new JSONArray(requestJson);
            for (int i = 0; i < req.length(); i++) {
                JSONObject r = req.optJSONObject(i);
                Entry e = r == null ? null : find(g, r.optString("id", ""), r.optString("name", ""));
                if (e == null) continue;
                if (e.progs.length() > 2) listings++;
                if (!e.icon.isEmpty()) logos++;
            }
        } catch (Exception ignored) {
            // Count what we could.
        }
        return "{\"listings\":" + listings + ",\"logos\":" + logos + "}";
    }

    private static Entry find(Guide g, String id, String name) {
        Entry e = id.isEmpty() ? null : g.read(key(id));
        if (e != null) return e;
        String byName = name.isEmpty() ? null : g.idByName.get(normal(name));
        return byName == null ? null : g.read(byName);
    }

    // ---------- Reading the guide ----------

    private static Guide build(Context context, String url, String userAgent) throws Exception {
        File xml = download(context, url, userAgent);
        long now = System.currentTimeMillis();
        long from = now - BEFORE_MS, to = now + AHEAD_MS;
        Map<String, String[]> channels = new HashMap<>();          // key -> {name, icon}
        Map<String, List<String>> progs = new HashMap<>();          // key -> ["[start,end,title,desc]", ...]
        int count = 0;

        try (InputStream raw = new BufferedInputStream(new FileInputStream(xml), 65536)) {
            InputStream in = maybeGunzip(raw);
            XmlPullParserFactory factory = XmlPullParserFactory.newInstance();
            factory.setNamespaceAware(false);
            XmlPullParser p = factory.newPullParser();
            p.setInput(in, null);
            String chId = null, chName = null, chIcon = null;
            String progCh = null, title = null, desc = null;
            long start = 0, stop = 0;
            boolean inProg = false;
            for (int ev = p.getEventType(); ev != XmlPullParser.END_DOCUMENT; ev = p.next()) {
                if (ev == XmlPullParser.START_TAG) {
                    String tag = p.getName();
                    if ("channel".equals(tag)) {
                        chId = p.getAttributeValue(null, "id");
                        chName = null; chIcon = null;
                    } else if (chId != null && "display-name".equals(tag)) {
                        String n = p.nextText();
                        if (chName == null) chName = n.trim();
                    } else if (chId != null && "icon".equals(tag)) {
                        if (chIcon == null) chIcon = p.getAttributeValue(null, "src");
                    } else if ("programme".equals(tag)) {
                        progCh = p.getAttributeValue(null, "channel");
                        start = time(p.getAttributeValue(null, "start"));
                        stop = time(p.getAttributeValue(null, "stop"));
                        title = null; desc = null;
                        inProg = progCh != null && stop > from && start < to && stop > start;
                    } else if (inProg && "title".equals(tag)) {
                        if (title == null) title = p.nextText().trim();
                    } else if (inProg && "desc".equals(tag)) {
                        if (desc == null) {
                            desc = p.nextText().trim();
                            if (desc.length() > MAX_DESC) desc = desc.substring(0, MAX_DESC - 1) + "…";
                        }
                    }
                } else if (ev == XmlPullParser.END_TAG) {
                    String tag = p.getName();
                    if ("channel".equals(tag) && chId != null) {
                        channels.put(key(chId), new String[]{chName == null ? "" : chName, chIcon == null ? "" : chIcon});
                        chId = null;
                    } else if ("programme".equals(tag)) {
                        if (inProg && title != null) {
                            String k = key(progCh);
                            List<String> list = progs.get(k);
                            if (list == null) progs.put(k, list = new ArrayList<>());
                            list.add("[" + start + "," + stop + "," + JSONObject.quote(title) + "," + JSONObject.quote(desc == null ? "" : desc) + "]");
                            count++;
                        }
                        inProg = false;
                    }
                }
            }
        }

        // Write it straight to the saved file, one channel per line, then index that file.
        File file = savedFile(context, url);
        File tmp = new File(file.getPath() + "." + Thread.currentThread().getId() + ".part");
        Set<String> keys = new HashSet<>(channels.keySet());
        keys.addAll(progs.keySet());
        try (BufferedWriter w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8), 65536)) {
            w.write(clean(url) + "\t" + now + "\t" + count + "\n");
            for (String k : keys) {
                String[] ch = channels.get(k);
                List<String> list = progs.remove(k);
                if (list != null) java.util.Collections.sort(list, (a, b) -> Long.compare(startOf(a), startOf(b)));
                w.write(clean(k) + "\t" + clean(ch == null ? "" : ch[0]) + "\t" + clean(ch == null ? "" : ch[1]) + "\t");
                if (list == null) w.write("[]");
                else {
                    w.write('[');
                    for (int i = 0; i < list.size(); i++) { if (i > 0) w.write(','); w.write(list.get(i)); }
                    w.write(']');
                }
                w.write('\n');
            }
        } catch (IOException e) {
            tmp.delete();
            throw e;
        }
        channels.clear();
        if (!tmp.renameTo(file)) { tmp.delete(); throw new IOException("couldn't save the guide"); }
        Guide g = readSaved(context, url);
        if (g == null) throw new IOException("couldn't read the saved guide");
        return g;
    }

    private static long startOf(String prog) {
        int comma = prog.indexOf(',');
        try { return Long.parseLong(prog.substring(1, comma)); } catch (Exception e) { return 0; }
    }

    private static void refreshLater(Context context, String url, String userAgent) {
        synchronized (refreshing) {
            if (!refreshing.add(url)) return;
        }
        Thread t = new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
            try {
                Guide g = build(context, url, userAgent);
                Guide c = current;
                if (c == null || c.url.equals(url)) current = g;
            } catch (Throwable ignored) {
                // Keep using the guide we have.
            } finally {
                synchronized (refreshing) { refreshing.remove(url); }
            }
        }, "aurora-epg-refresh");
        t.start();
    }

    // ---------- Saved copy ----------
    // One line per channel: key \t name \t icon \t programmes-json. First line: url \t builtAt \t programme count.

    private static File savedFile(Context context, String url) throws IOException {
        return new File(cacheDir(context), Integer.toHexString(url.hashCode()) + ".guide");
    }

    /** Indexes the saved file: reads each line's key and name and remembers where the line is. */
    private static Guide readSaved(Context context, String url) {
        try {
            File file = savedFile(context, url);
            if (!file.exists()) return null;
            Map<String, long[]> lineById = new HashMap<>();
            Map<String, String> idByName = new HashMap<>();
            long builtAt;
            int programmes;
            try (InputStream in = new BufferedInputStream(new FileInputStream(file), 65536)) {
                java.io.ByteArrayOutputStream line = new java.io.ByteArrayOutputStream(256);
                long pos = 0, start = 0;
                String[] head = null;
                builtAt = 0; programmes = 0;
                // Only the first three fields of each line are needed here; the listings are skipped over.
                int tabs = 0;
                for (int c; (c = in.read()) != -1; pos++) {
                    if (c == '\n') {
                        String text = line.toString("UTF-8");
                        if (head == null) {
                            head = text.split("\t");
                            if (head.length < 3 || !head[0].equals(clean(url))) return null;
                            builtAt = Long.parseLong(head[1]);
                            programmes = Integer.parseInt(head[2]);
                        } else {
                            String[] f = text.split("\t", 3);
                            if (f.length >= 2) {
                                lineById.put(f[0], new long[]{start, pos - start});
                                if (!f[1].isEmpty() && !idByName.containsKey(normal(f[1]))) idByName.put(normal(f[1]), f[0]);
                            }
                        }
                        line.reset();
                        tabs = 0;
                        start = pos + 1;
                    } else if (head == null || tabs < 2) {
                        if (c == '\t') tabs++;
                        if (head == null || tabs < 2) line.write(c);
                    }
                }
            }
            return new Guide(url, builtAt, file, lineById, idByName, programmes);
        } catch (Exception e) {
            return null;
        }
    }

    private static String clean(String s) { return s == null ? "" : s.replace('\t', ' ').replace('\n', ' ').replace('\r', ' '); }

    // ---------- Helpers ----------

    private static String key(String id) { return id.trim().toLowerCase(Locale.ROOT); }

    /** Channel names compared loosely: case, spaces and punctuation ignored. */
    static String normal(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }

    /** XMLTV times look like "20240101203000 +0100"; the offset is optional (then UTC). */
    static long time(String s) {
        if (s == null || s.length() < 14) return 0;
        String digits = s.substring(0, 14), rest = s.substring(14).trim();
        SimpleDateFormat f = new SimpleDateFormat(rest.isEmpty() ? "yyyyMMddHHmmss" : "yyyyMMddHHmmss Z", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        java.util.Date d = f.parse(rest.isEmpty() ? digits : digits + " " + rest.split("\\s+")[0], new ParsePosition(0));
        return d == null ? 0 : d.getTime();
    }

    /** null if the file looks like an XMLTV guide (plain or gzipped); otherwise what it is instead, for the app log. */
    static String notAGuide(File f) {
        byte[] head = new byte[4096];
        int n = 0;
        try (InputStream raw = new BufferedInputStream(new FileInputStream(f), 65536)) {
            InputStream in = maybeGunzip(raw);
            for (int r; n < head.length && (r = in.read(head, n, head.length - n)) > 0; ) n += r;
        } catch (IOException e) {
            return "The guide file couldn't be read (" + e.getMessage() + ")";
        }
        String start = new String(head, 0, n, StandardCharsets.UTF_8).replace("\uFEFF", "").trim();
        String lower = start.toLowerCase(Locale.ROOT);
        if (lower.startsWith("<?xml") || lower.startsWith("<tv") || lower.startsWith("<!doctype tv") || lower.startsWith("<!--")) return null;
        String title = "";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("<title[^>]*>([^<]{1,120})", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(start);
        if (m.find()) title = m.group(1).trim();
        else if (!lower.startsWith("<")) title = start.substring(0, Math.min(80, start.length())).replaceAll("\\s+", " ");
        boolean page = lower.startsWith("<!doctype html") || lower.startsWith("<html") || lower.contains("<body");
        return (page ? "The TV provider sent a web page instead of the guide" : "The guide address didn't send a TV guide")
                + (title.isEmpty() ? "" : " (\"" + title + "\")")
                + ". The provider may be blocking this internet connection, or the account may be busy or expired.";
    }

    private static InputStream maybeGunzip(InputStream in) throws IOException {
        in.mark(2);
        int a = in.read(), b = in.read();
        in.reset();
        return (a == 0x1f && b == 0x8b) ? new BufferedInputStream(new GZIPInputStream(in, 65536), 65536) : in;
    }

    private static File cacheDir(Context context) throws IOException {
        File dir = new File(context.getCacheDir(), "epg");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("no cache folder");
        return dir;
    }

    /** Clears out guides nobody has used in a couple of days (old links, earlier versions of the app). */
    private static void tidy(File dir) {
        File[] old = dir.listFiles();
        long cutoff = System.currentTimeMillis() - 48 * 3600_000L;
        for (int i = 0; old != null && i < old.length; i++) if (old[i].lastModified() < cutoff) old[i].delete();
    }

    /** Downloads the guide to the app's cache, reusing a copy less than six hours old. Follows any redirects. */
    private static File download(Context context, String url, String userAgent) throws IOException {
        File dir = cacheDir(context);
        tidy(dir);
        File file = new File(dir, Integer.toHexString(url.hashCode()) + ".xml");
        if (file.exists() && System.currentTimeMillis() - file.lastModified() < DOWNLOAD_MS && file.length() > 0) {
            // Older versions could have saved a provider's error page here; never reuse one of those.
            if (notAGuide(file) == null) return file;
            file.delete();
        }
        File tmp = new File(dir, file.getName() + "." + Thread.currentThread().getId() + ".part");
        HttpURLConnection conn = null;
        try {
            String at = url;
            for (int hop = 0; ; hop++) {
                conn = (HttpURLConnection) new URL(at).openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(90000);
                // Java won't follow a redirect between http and https on its own; providers often use one.
                conn.setInstanceFollowRedirects(false);
                if (userAgent != null && !userAgent.isEmpty()) conn.setRequestProperty("User-Agent", userAgent);
                int status = conn.getResponseCode();
                if (status >= 300 && status < 400 && hop < MAX_REDIRECTS) {
                    String next = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (next == null) throw new IOException("The guide address redirected nowhere");
                    at = new URL(new URL(at), next).toString();
                    continue;
                }
                if (status >= 400) throw new IOException("The guide address answered " + status);
                break;
            }
            long size = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) { out.write(buf, 0, n); size += n; }
            }
            if (size < 20) throw new IOException("The guide address sent back an empty guide");
            // A web page instead of a guide (the provider's error, block or "too many connections" page, often sent with
            // status 200): say so, and keep the last good guide rather than replacing it with the page.
            String why = notAGuide(tmp);
            if (why != null) throw new IOException(why);
            if (!tmp.renameTo(file)) throw new IOException("couldn't save the guide");
        } catch (IOException e) {
            tmp.delete();
            // A stale copy is better than no guide at all.
            if (file.exists() && file.length() > 0 && notAGuide(file) == null) return file;
            throw e;
        } finally {
            if (conn != null) conn.disconnect();
        }
        return file;
    }
}
