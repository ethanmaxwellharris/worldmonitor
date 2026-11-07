/**
 * GET /api/local/events
 * Upcoming events near home from the Ticketmaster Discovery API.
 * Requires TICKETMASTER_API_KEY (free key: 5,000 calls/day, 5 req/s).
 * Without a key the route responds 200 with enabled:false so the UI can
 * show a friendly "add a key" message. Cached 1 h.
 */
import { preamble, json, cached, stale, fetchWithTimeout } from './_shared.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const pre = preamble(request);
  if (pre.response) return pre.response;
  const { cors, cfg } = pre;
  const apiKey = (process.env.TICKETMASTER_API_KEY || '').trim();
  if (!apiKey) {
    return json({ configured: true, enabled: false, reason: 'TICKETMASTER_API_KEY not configured', events: [] }, { cors, maxAge: 300 });
  }
  const key = `local:events:v1:${cfg.lat.toFixed(2)},${cfg.lon.toFixed(2)}:${cfg.eventsRadiusMi}`;

  try {
    const { value, cached: hit } = await cached(key, 3600, async () => {
      const q = new URLSearchParams({
        apikey: apiKey,
        latlong: `${cfg.lat.toFixed(4)},${cfg.lon.toFixed(4)}`,
        radius: String(Math.round(cfg.eventsRadiusMi)),
        unit: 'miles',
        sort: 'date,asc',
        size: '30',
        startDateTime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
      const res = await fetchWithTimeout(`https://app.ticketmaster.com/discovery/v2/events.json?${q}`, {
        headers: { Accept: 'application/json' },
      }, 10000);
      if (!res.ok) throw new Error(`Ticketmaster HTTP ${res.status}`);
      const data = await res.json();
      const events = data._embedded?.events || [];
      return events.map((e) => {
        const venue = e._embedded?.venues?.[0] || {};
        return {
          id: e.id,
          name: e.name,
          url: e.url,
          date: e.dates?.start?.localDate || null,
          time: e.dates?.start?.localTime || null,
          dateTime: e.dates?.start?.dateTime || null,
          status: e.dates?.status?.code || null,
          segment: e.classifications?.[0]?.segment?.name || null,
          genre: e.classifications?.[0]?.genre?.name || null,
          venue: venue.name || null,
          city: venue.city?.name || null,
          distanceMi: Number.isFinite(e.distance) ? Math.round(e.distance) : null,
        };
      });
    });
    return json({ configured: true, enabled: true, radiusMi: cfg.eventsRadiusMi, events: value, cached: hit, attribution: 'Data: Ticketmaster Discovery API' }, { cors, maxAge: 600 });
  } catch (error) {
    const old = stale(key);
    if (old) return json({ configured: true, enabled: true, events: old, stale: true }, { cors });
    // Never echo the upstream URL: it contains the API key.
    return json({ configured: true, enabled: true, events: [], error: String(error.message || error).replace(apiKey, '***') }, { status: 502, cors });
  }
}
