/**
 * GET /api/local/aircraft
 * Aircraft within LOCAL_RADIUS_NM of the home point.
 * Primary: adsb.lol (free, ODbL, no key). Fallback: OpenSky anonymous bbox query.
 * Cached 10 s per location to respect both services' rate limits.
 */
import {
  preamble, json, cached, stale, fetchWithTimeout,
  distanceKm, bearingDeg, compass, roundTo,
} from './_shared.js';

export const config = { runtime: 'edge' };

const TTL_SECONDS = 10;
const KM_PER_NM = 1.852;
const FT_PER_M = 3.28084;

function shape(list, cfg, source) {
  const out = [];
  for (const a of list) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    const dKm = distanceKm(cfg.lat, cfg.lon, a.lat, a.lon);
    if (dKm > cfg.radiusNm * KM_PER_NM) continue;
    const brg = bearingDeg(cfg.lat, cfg.lon, a.lat, a.lon);
    const altFt = Number.isFinite(a.altFt) ? a.altFt : null;
    // Elevation angle above the horizon from the observer (flat-earth approx, fine < 100 nm).
    const elevationDeg = altFt !== null && dKm > 0.05
      ? Math.max(0, Math.round((Math.atan2(Math.max(0, altFt) / FT_PER_M / 1000, dKm) * 180) / Math.PI))
      : (altFt !== null && altFt > 0 ? 90 : (altFt !== null ? 0 : null));
    out.push({
      hex: a.hex,
      callsign: (a.callsign || '').trim() || null,
      registration: a.registration || null,
      type: a.type || null,
      altitudeFt: altFt,
      onGround: Boolean(a.onGround),
      speedKt: Number.isFinite(a.speedKt) ? Math.round(a.speedKt) : null,
      trackDeg: Number.isFinite(a.track) ? Math.round(a.track) : null,
      verticalRateFpm: Number.isFinite(a.vrate) ? Math.round(a.vrate) : null,
      squawk: a.squawk || null,
      emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
      military: Boolean(a.military),
      lat: a.lat,
      lon: a.lon,
      // Coarse relative position (privacy: avoid precise trilateration of home).
      distanceNm: roundTo(dKm / KM_PER_NM, 0.5),
      bearingDeg: roundTo(brg, 5) % 360,
      direction: compass(brg),
      elevationDeg,
      source,
    });
  }
  out.sort((a, b) => a.distanceNm - b.distanceNm);
  return out;
}

async function fromAdsbLol(cfg) {
  const url = `https://api.adsb.lol/v2/point/${cfg.lat.toFixed(4)}/${cfg.lon.toFixed(4)}/${Math.round(cfg.radiusNm)}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': cfg.userAgent } }, 8000);
  if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`);
  const data = await res.json();
  const ac = Array.isArray(data.ac) ? data.ac : [];
  return ac.map((a) => ({
    hex: a.hex,
    callsign: a.flight,
    registration: a.r,
    type: a.t,
    altFt: a.alt_baro === 'ground' ? 0 : (Number.isFinite(a.alt_baro) ? a.alt_baro : a.alt_geom),
    onGround: a.alt_baro === 'ground',
    speedKt: a.gs,
    track: a.track,
    vrate: a.baro_rate ?? a.geom_rate,
    squawk: a.squawk,
    emergency: a.emergency,
    military: typeof a.dbFlags === 'number' && (a.dbFlags & 1) === 1,
    lat: a.lat,
    lon: a.lon,
  }));
}

async function fromOpenSky(cfg) {
  const dLat = (cfg.radiusNm * KM_PER_NM) / 111;
  const dLon = dLat / Math.max(0.1, Math.cos((cfg.lat * Math.PI) / 180));
  const q = new URLSearchParams({
    lamin: (cfg.lat - dLat).toFixed(3), lamax: (cfg.lat + dLat).toFixed(3),
    lomin: (cfg.lon - dLon).toFixed(3), lomax: (cfg.lon + dLon).toFixed(3),
  });
  const res = await fetchWithTimeout(`https://opensky-network.org/api/states/all?${q}`, {
    headers: { Accept: 'application/json', 'User-Agent': cfg.userAgent },
  }, 8000);
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
  const data = await res.json();
  const states = Array.isArray(data.states) ? data.states : [];
  return states.map((s) => ({
    hex: s[0],
    callsign: s[1],
    altFt: Number.isFinite(s[7]) ? Math.round(s[7] * FT_PER_M) : (Number.isFinite(s[13]) ? Math.round(s[13] * FT_PER_M) : null),
    onGround: s[8],
    speedKt: Number.isFinite(s[9]) ? s[9] * 1.94384 : null,
    track: s[10],
    vrate: Number.isFinite(s[11]) ? s[11] * 196.85 : null,
    squawk: s[14],
    lat: s[6],
    lon: s[5],
  }));
}

export default async function handler(request) {
  const pre = preamble(request);
  if (pre.response) return pre.response;
  const { cors, cfg } = pre;
  const key = `local:aircraft:v1:${cfg.lat.toFixed(3)},${cfg.lon.toFixed(3)}:${cfg.radiusNm}`;

  try {
    const { value, cached: hit } = await cached(key, TTL_SECONDS, async () => {
      const errors = [];
      try {
        return { source: 'adsb.lol', aircraft: shape(await fromAdsbLol(cfg), cfg, 'adsb.lol') };
      } catch (e) { errors.push(String(e.message || e)); }
      try {
        return { source: 'opensky', aircraft: shape(await fromOpenSky(cfg), cfg, 'opensky'), errors };
      } catch (e) { errors.push(String(e.message || e)); }
      throw new Error(errors.join('; '));
    });
    return json({
      configured: true,
      radiusNm: cfg.radiusNm,
      count: value.aircraft.length,
      ...value,
      cached: hit,
      fetchedAt: new Date().toISOString(),
      attribution: value.source === 'adsb.lol' ? 'Data: adsb.lol (ODbL)' : 'Data: The OpenSky Network',
    }, { cors, maxAge: TTL_SECONDS });
  } catch (error) {
    const old = stale(key);
    if (old) return json({ configured: true, ...old, stale: true, error: String(error.message || error) }, { cors });
    return json({ configured: true, aircraft: [], count: 0, error: String(error.message || error) }, { status: 502, cors });
  }
}
