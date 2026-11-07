/**
 * GET /api/local/news
 * Local headlines: Google News RSS search for LOCAL_PLACE (or LOCAL_NEWS_QUERY),
 * plus optional outlet feeds in LOCAL_NEWS_FEEDS (comma-separated https RSS URLs).
 * Free, no key. Cached 10 min so feeds are polled lightly.
 */
import { preamble, json, cached, stale, fetchWithTimeout, parseFeed } from './_shared.js';
import { hashString } from '../_upstash-cache.js';

export const config = { runtime: 'edge' };

const MAX_EXTRA_FEEDS = 8;

function feedList(cfg) {
  const feeds = [];
  const query = (process.env.LOCAL_NEWS_QUERY || '').trim() || (cfg.place ? `"${cfg.place}"` : '');
  if (query) {
    const q = encodeURIComponent(`${query} when:2d`);
    feeds.push({ name: 'Google News', url: `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en` });
  }
  const extra = (process.env.LOCAL_NEWS_FEEDS || '')
    .split(',').map((s) => s.trim()).filter((u) => /^https:\/\//i.test(u)).slice(0, MAX_EXTRA_FEEDS);
  for (const url of extra) {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep url */ }
    feeds.push({ name: host, url });
  }
  return feeds;
}

export default async function handler(request) {
  const pre = preamble(request);
  if (pre.response) return pre.response;
  const { cors, cfg } = pre;
  const feeds = feedList(cfg);
  if (feeds.length === 0) {
    return json({ configured: true, enabled: false, reason: 'Set LOCAL_PLACE (e.g. "Springfield, IL") or LOCAL_NEWS_FEEDS', items: [] }, { cors });
  }
  const key = `local:news:v1:${hashString(feeds.map((f) => f.url).join('|'))}`;

  try {
    const { value, cached: hit } = await cached(key, 600, async () => {
      const results = await Promise.allSettled(feeds.map(async (f) => {
        const res = await fetchWithTimeout(f.url, {
          headers: { 'User-Agent': cfg.userAgent, Accept: 'application/rss+xml, application/xml, text/xml' },
        }, 10000);
        if (!res.ok) throw new Error(`${f.name} HTTP ${res.status}`);
        return parseFeed(await res.text(), f.name);
      }));
      const seen = new Set();
      const items = [];
      const errors = [];
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') { errors.push(String(r.reason?.message || r.reason)); return; }
        for (const item of r.value) {
          const norm = item.title.toLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^\w\s]/g, '').trim();
          if (seen.has(norm)) continue;
          seen.add(norm);
          items.push({ ...item, feed: feeds[i].name });
        }
      });
      if (items.length === 0 && errors.length) throw new Error(errors.join('; '));
      items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
      return { items: items.slice(0, 50), errors };
    });
    return json({ configured: true, enabled: true, place: cfg.place || null, ...value, cached: hit }, { cors, maxAge: 300 });
  } catch (error) {
    const old = stale(key);
    if (old) return json({ configured: true, enabled: true, ...old, stale: true }, { cors });
    return json({ configured: true, enabled: true, items: [], error: String(error.message || error) }, { status: 502, cors });
  }
}
