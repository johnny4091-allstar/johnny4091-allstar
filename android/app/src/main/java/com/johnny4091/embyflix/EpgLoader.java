package com.johnny4091.embyflix;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserFactory;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
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
 * Reads an XMLTV guide (plain or gzipped) without loading it all into memory, keeping only the channels the
 * app asked for and the programmes in the next few hours. Guides can be tens of megabytes, too much for the
 * web page to download and parse on a TV box.
 *
 * Result JSON: {channels: {id: {n: name, i: icon}}, programmes: {id: [[startMs, endMs, title, desc], ...]}}
 */
final class EpgLoader {
    private static final long CACHE_MS = 6 * 3600_000L;

    private EpgLoader() {}

    static String load(Context context, String url, String userAgent, int hoursAhead, String wantedJson) throws Exception {
        File file = download(context, url, userAgent);
        Set<String> wantedIds = new HashSet<>(), wantedNames = new HashSet<>();
        if (wantedJson != null && !wantedJson.isEmpty()) {
            JSONObject wanted = new JSONObject(wantedJson);
            JSONArray ids = wanted.optJSONArray("ids"), names = wanted.optJSONArray("names");
            for (int i = 0; ids != null && i < ids.length(); i++) wantedIds.add(ids.getString(i).trim().toLowerCase(Locale.ROOT));
            for (int i = 0; names != null && i < names.length(); i++) wantedNames.add(normal(names.getString(i)));
        }
        boolean filter = !wantedIds.isEmpty() || !wantedNames.isEmpty();
        long now = System.currentTimeMillis();
        long from = now - 3600_000L, to = now + Math.max(1, hoursAhead) * 3600_000L;

        Map<String, String[]> channels = new HashMap<>();      // id -> {name, icon}
        Set<String> keep = new HashSet<>();
        Map<String, List<Object[]>> programmes = new HashMap<>();

        try (InputStream raw = new BufferedInputStream(new FileInputStream(file), 65536)) {
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
                        if (chName == null) chName = n;
                        if (filter && wantedNames.contains(normal(n))) keep.add(key(chId));
                    } else if (chId != null && "icon".equals(tag)) {
                        if (chIcon == null) chIcon = p.getAttributeValue(null, "src");
                    } else if ("programme".equals(tag)) {
                        progCh = p.getAttributeValue(null, "channel");
                        start = time(p.getAttributeValue(null, "start"));
                        stop = time(p.getAttributeValue(null, "stop"));
                        title = null; desc = null;
                        inProg = progCh != null && stop > from && start < to && (!filter || keep.contains(key(progCh)));
                    } else if (inProg && "title".equals(tag)) {
                        if (title == null) title = p.nextText();
                    } else if (inProg && "desc".equals(tag)) {
                        if (desc == null) {
                            desc = p.nextText();
                            if (desc.length() > 220) desc = desc.substring(0, 217) + "…";
                        }
                    }
                } else if (ev == XmlPullParser.END_TAG) {
                    String tag = p.getName();
                    if ("channel".equals(tag) && chId != null) {
                        if (!filter || wantedIds.contains(key(chId))) keep.add(key(chId));
                        if (keep.contains(key(chId))) channels.put(chId, new String[]{chName == null ? "" : chName, chIcon == null ? "" : chIcon});
                        chId = null;
                    } else if ("programme".equals(tag)) {
                        if (inProg && title != null) {
                            List<Object[]> list = programmes.get(progCh);
                            if (list == null) programmes.put(progCh, list = new ArrayList<>());
                            list.add(new Object[]{start, stop, title, desc == null ? "" : desc});
                        }
                        inProg = false;
                    }
                }
            }
        }

        StringBuilder out = new StringBuilder(1 << 16);
        out.append("{\"channels\":{");
        boolean first = true;
        for (Map.Entry<String, String[]> e : channels.entrySet()) {
            if (!first) out.append(',');
            first = false;
            out.append(JSONObject.quote(e.getKey())).append(":{\"n\":").append(JSONObject.quote(e.getValue()[0]))
                    .append(",\"i\":").append(JSONObject.quote(e.getValue()[1])).append('}');
        }
        out.append("},\"programmes\":{");
        first = true;
        for (Map.Entry<String, List<Object[]>> e : programmes.entrySet()) {
            if (!first) out.append(',');
            first = false;
            out.append(JSONObject.quote(e.getKey())).append(":[");
            boolean f2 = true;
            for (Object[] pr : e.getValue()) {
                if (!f2) out.append(',');
                f2 = false;
                out.append('[').append(pr[0]).append(',').append(pr[1]).append(',')
                        .append(JSONObject.quote((String) pr[2])).append(',').append(JSONObject.quote((String) pr[3])).append(']');
            }
            out.append(']');
        }
        out.append("}}");
        return out.toString();
    }

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

    private static InputStream maybeGunzip(InputStream in) throws IOException {
        in.mark(2);
        int a = in.read(), b = in.read();
        in.reset();
        return (a == 0x1f && b == 0x8b) ? new BufferedInputStream(new GZIPInputStream(in, 65536), 65536) : in;
    }

    /** Downloads the guide to the app's cache, reusing a copy less than six hours old. */
    private static File download(Context context, String url, String userAgent) throws IOException {
        File dir = new File(context.getCacheDir(), "epg");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("no cache folder");
        File file = new File(dir, Integer.toHexString(url.hashCode()) + ".xml");
        if (file.exists() && System.currentTimeMillis() - file.lastModified() < CACHE_MS && file.length() > 0) return file;
        HttpURLConnection conn = null;
        File tmp = new File(dir, file.getName() + ".part");
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(true);
            if (userAgent != null && !userAgent.isEmpty()) conn.setRequestProperty("User-Agent", userAgent);
            int status = conn.getResponseCode();
            if (status >= 400) throw new IOException("The guide address answered " + status);
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            if (!tmp.renameTo(file)) throw new IOException("couldn't save the guide");
        } catch (IOException e) {
            tmp.delete();
            // A stale copy is better than no guide at all.
            if (file.exists() && file.length() > 0) return file;
            throw e;
        } finally {
            if (conn != null) conn.disconnect();
        }
        return file;
    }
}
