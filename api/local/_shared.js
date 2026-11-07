/**
 * Shared helpers for the Local Monitor API routes (api/local/*).
 *
 * Privacy model: the home location lives ONLY in server-side env vars
 * (LOCAL_LAT / LOCAL_LON). Never expose them through VITE_* vars. Responses
 * return a rounded center (~11 km) and coarse distances/bearings so the exact
 * point is not published. Aircraft and satellite data near a location is
 * still inherently location-revealing: deploy the local variant behind
 * Vercel Authentication (or another access gate) before setting real coords.
 */

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { getCachedJson, setCachedJson } from '../_upstash-cache.js';

export const DEFAULT_USER_AGENT =
  'WorldMonitor-Local/1.0 (+https://github.com/ethanmaxwellharris/worldmonitor)';

function num(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Reads the Local Monitor config from env. Returns null when unconfigured. */
export function getLocalConfig() {
  const lat = num(process.env.LOCAL_LAT, NaN);
  const lon = num(process.env.LOCAL_LON, NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return {
    lat,
    lon,
    place: (process.env.LOCAL_PLACE || '').trim(),
    radiusNm: clamp(num(process.env.LOCAL_RADIUS_NM, 25), 1, 250),
    quakeRadiusKm: clamp(num(process.env.LOCAL_QUAKE_RADIUS_KM, 250), 10, 2000),
    eventsRadiusMi: clamp(num(process.env.LOCAL_EVENTS_RADIUS_MI, 25), 1, 200),
    userAgent: (process.env.LOCAL_USER_AGENT || '').trim() || DEFAULT_USER_AGENT,
  };
}

/** Rounded center that is safe to send to the browser (1 decimal ≈ 11 km). */
export function publicCenter(cfg) {
  return { lat: Math.round(cfg.lat * 10) / 10, lon: Math.round(cfg.lon * 10) / 10 };
}

export function json(body, { status = 200, cors = {}, maxAge = 0 } = {}) {
  const headers = { 'Content-Type': 'application/json', ...cors };
  // Never cache on shared CDNs: responses are derived from private env config.
  headers['Cache-Control'] = maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Standard preamble: CORS, method and origin checks, config lookup.
 * Returns either { response } (early exit) or { cors, cfg }.
 */
export function preamble(request) {
  const cors = getCorsHeaders(request, 'GET, OPTIONS');
  if (request.method === 'OPTIONS') return { response: new Response(null, { status: 204, headers: cors }) };
  if (request.method !== 'GET') return { response: json({ error: 'Method not allowed' }, { status: 405, cors }) };
  if (isDisallowedOrigin(request)) return { response: json({ error: 'Origin not allowed' }, { status: 403 }) };
  const cfg = getLocalConfig();
  if (!cfg) {
    return {
      response: json({
        configured: false,
        reason: 'LOCAL_LAT / LOCAL_LON not set on the server',
      }, { cors }),
    };
  }
  return { cors, cfg };
}

// ── Two-tier cache: per-isolate memory + Upstash (when configured) ──
const memCache = new Map();

export async function cached(key, ttlSeconds, producer) {
  const now = Date.now();
  const mem = memCache.get(key);
  if (mem && mem.expiresAt > now) return { value: mem.value, cached: true };

  const remote = await getCachedJson(key).catch(() => null);
  if (remote && typeof remote === 'object' && remote.__v !== undefined) {
    memCache.set(key, { value: remote.__v, expiresAt: now + ttlSeconds * 1000 });
    return { value: remote.__v, cached: true };
  }

  const value = await producer();
  memCache.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
  if (memCache.size > 200) {
    for (const [k, v] of memCache) if (v.expiresAt <= now) memCache.delete(k);
  }
  await setCachedJson(key, { __v: value }, ttlSeconds).catch(() => false);
  return { value, cached: false };
}

/** Returns a stale in-memory value even if expired (for upstream failures). */
export function stale(key) {
  return memCache.get(key)?.value ?? null;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Geo helpers ──
const R_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function compass(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export const roundTo = (n, step) => Math.round(n / step) * step;

export function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** Minimal RSS 2.0 / Atom item parser (enough for Google News + outlet feeds). */
export function parseFeed(xml, sourceFallback = '') {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const tag = (name) => {
      const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
      return m ? decodeXml(m[1]) : '';
    };
    let link = tag('link');
    if (!link) {
      const m = block.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : '';
    }
    const title = tag('title').replace(/<[^>]+>/g, '');
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const published = tag('pubDate') || tag('published') || tag('updated');
    const ts = Date.parse(published);
    items.push({
      title,
      link,
      source: tag('source') || sourceFallback,
      publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
    });
  }
  return items;
}
