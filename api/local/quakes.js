/**
 * GET /api/local/quakes
 * USGS FDSN earthquakes within LOCAL_QUAKE_RADIUS_KM over the past 30 days (M1+).
 * Free, no key. Cached 5 min.
 */
import { preamble, json, cached, stale, fetchWithTimeout, distanceKm, bearingDeg, compass, roundTo } from './_shared.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const pre = preamble(request);
  if (pre.response) return pre.response;
  const { cors, cfg } = pre;
  const key = `local:quakes:v1:${cfg.lat.toFixed(2)},${cfg.lon.toFixed(2)}:${cfg.quakeRadiusKm}`;

  try {
    const { value, cached: hit } = await cached(key, 300, async () => {
      const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const q = new URLSearchParams({
        format: 'geojson',
        latitude: cfg.lat.toFixed(3),
        longitude: cfg.lon.toFixed(3),
        maxradiuskm: String(cfg.quakeRadiusKm),
        starttime: start,
        minmagnitude: '1',
        orderby: 'time',
        limit: '100',
      });
      const res = await fetchWithTimeout(`https://earthquake.usgs.gov/fdsnws/event/1/query?${q}`, {
        headers: { Accept: 'application/json', 'User-Agent': cfg.userAgent },
      }, 10000);
      if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
      const features = (await res.json()).features || [];
      return features.map((f) => {
        const [lon, lat, depth] = f.geometry?.coordinates || [];
        const p = f.properties || {};
        const dKm = distanceKm(cfg.lat, cfg.lon, lat, lon);
        return {
          id: f.id,
          magnitude: p.mag,
          place: p.place,
          time: p.time ? new Date(p.time).toISOString() : null,
          depthKm: Number.isFinite(depth) ? Math.round(depth * 10) / 10 : null,
          lat, lon,
          distanceKm: roundTo(dKm, 1),
          direction: compass(bearingDeg(cfg.lat, cfg.lon, lat, lon)),
          felt: p.felt ?? null,
          tsunami: Boolean(p.tsunami),
          alert: p.alert || null,
          url: p.url,
        };
      });
    });
    return json({
      configured: true,
      radiusKm: cfg.quakeRadiusKm,
      count: value.length,
      quakes: value,
      cached: hit,
      attribution: 'Data: U.S. Geological Survey',
    }, { cors, maxAge: 120 });
  } catch (error) {
    const old = stale(key);
    if (old) return json({ configured: true, quakes: old, count: old.length, stale: true, error: String(error.message || error) }, { cors });
    return json({ configured: true, quakes: [], count: 0, error: String(error.message || error) }, { status: 502, cors });
  }
}
