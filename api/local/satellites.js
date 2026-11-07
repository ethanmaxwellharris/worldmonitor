/**
 * GET /api/local/satellites
 * Satellites above the home horizon right now, plus upcoming passes of
 * headline objects (ISS, Tiangong, Hubble) over the next 24 h.
 *
 * TLEs come from CelesTrak GP (free, no key). CelesTrak asks clients not to
 * re-download the same group more than once every 2 hours, so TLE sets are
 * cached for 2 h (memory + Upstash). Propagation uses satellite.js (SGP4).
 */
import * as satellite from 'satellite.js';
import { preamble, json, cached, stale, fetchWithTimeout, compass } from './_shared.js';

export const config = { runtime: 'edge' };

const TLE_TTL_SECONDS = 2 * 60 * 60;
const RESULT_TTL_SECONDS = 30;
const GROUPS = ['stations', 'visual'];
const FEATURED = [
  { norad: 25544, name: 'ISS' },
  { norad: 48274, name: 'Tiangong (CSS)' },
  { norad: 20580, name: 'Hubble' },
];
const PASS_WINDOW_MIN = 24 * 60;
const PASS_STEP_SEC = 30;
const AU_KM = 149597870.7;
const EARTH_RADIUS_KM = 6371;
const DEG = 180 / Math.PI;

function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const sats = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i]?.trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!name || !l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
    sats.push({ name, norad: Number.parseInt(l1.slice(2, 7), 10), l1, l2 });
  }
  return sats;
}

async function loadGroup(group, userAgent) {
  const key = `local:tle:v1:${group}`;
  const { value } = await cached(key, TLE_TTL_SECONDS, async () => {
    const res = await fetchWithTimeout(
      `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`,
      { headers: { 'User-Agent': userAgent, Accept: 'text/plain' } },
      12000,
    );
    if (!res.ok) throw new Error(`CelesTrak ${group} HTTP ${res.status}`);
    const sats = parseTle(await res.text());
    if (sats.length === 0) throw new Error(`CelesTrak ${group} returned no TLEs`);
    return sats;
  }).catch((e) => {
    const old = stale(key);
    if (old) return { value: old };
    throw e;
  });
  return value;
}

/** Low-precision solar position, ECI unit vector (good to ~0.01°). */
function sunEciUnit(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) / DEG;
  const g = (357.528 + 0.9856003 * n) / DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) / DEG;
  const eps = (23.439 - 0.0000004 * n) / DEG;
  return {
    x: Math.cos(lambda),
    y: Math.cos(eps) * Math.sin(lambda),
    z: Math.sin(eps) * Math.sin(lambda),
  };
}

function isSunlit(posEci, sun) {
  const dot = posEci.x * sun.x + posEci.y * sun.y + posEci.z * sun.z;
  if (dot > 0) return true;
  const px = posEci.x - dot * sun.x;
  const py = posEci.y - dot * sun.y;
  const pz = posEci.z - dot * sun.z;
  return Math.sqrt(px * px + py * py + pz * pz) > EARTH_RADIUS_KM;
}

function sunElevationDeg(date, observerGd) {
  const sun = sunEciUnit(date);
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf({ x: sun.x * AU_KM, y: sun.y * AU_KM, z: sun.z * AU_KM }, gmst);
  return satellite.ecfToLookAngles(observerGd, ecf).elevation * DEG;
}

function look(satrec, date, observerGd) {
  const pv = satellite.propagate(satrec, date);
  const pos = pv && pv.position;
  if (!pos || typeof pos !== 'object') return null;
  const gmst = satellite.gstime(date);
  const la = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(pos, gmst));
  const gd = satellite.eciToGeodetic(pos, gmst);
  return {
    pos,
    azimuth: la.azimuth * DEG,
    elevation: la.elevation * DEG,
    rangeKm: la.rangeSat,
    altitudeKm: gd.height,
  };
}

function computePasses(sat, satrec, start, observerGd) {
  const passes = [];
  let current = null;
  for (let t = 0; t <= PASS_WINDOW_MIN * 60; t += PASS_STEP_SEC) {
    const date = new Date(start.getTime() + t * 1000);
    const l = look(satrec, date, observerGd);
    if (!l) break;
    if (l.elevation > 0) {
      const sunlit = isSunlit(l.pos, sunEciUnit(date));
      const dark = sunElevationDeg(date, observerGd) < -6;
      if (!current) {
        current = { name: sat.name, norad: sat.norad, rise: date, riseAz: l.azimuth, maxEl: l.elevation, maxAt: date, visible: false };
      }
      if (l.elevation > current.maxEl) { current.maxEl = l.elevation; current.maxAt = date; }
      if (sunlit && dark && l.elevation >= 10) current.visible = true;
      current.set = date; current.setAz = l.azimuth;
    } else if (current) {
      passes.push(current);
      current = null;
    }
  }
  if (current) passes.push(current);
  return passes
    .filter((p) => p.maxEl >= 10)
    .map((p) => ({
      name: p.name,
      norad: p.norad,
      rise: p.rise.toISOString(),
      riseDirection: compass(p.riseAz),
      maxAt: p.maxAt.toISOString(),
      maxElevationDeg: Math.round(p.maxEl),
      set: p.set.toISOString(),
      setDirection: compass(p.setAz),
      durationMin: Math.round((p.set - p.rise) / 60000),
      nakedEyeVisible: p.visible,
    }));
}

export default async function handler(request) {
  const pre = preamble(request);
  if (pre.response) return pre.response;
  const { cors, cfg } = pre;
  const key = `local:sats:v1:${cfg.lat.toFixed(3)},${cfg.lon.toFixed(3)}`;

  try {
    const { value, cached: hit } = await cached(key, RESULT_TTL_SECONDS, async () => {
      const groups = await Promise.all(GROUPS.map((g) => loadGroup(g, cfg.userAgent).catch(() => [])));
      const byId = new Map();
      groups.flat().forEach((s) => { if (!byId.has(s.norad)) byId.set(s.norad, s); });
      if (byId.size === 0) throw new Error('No TLE data available from CelesTrak');

      const observerGd = {
        latitude: satellite.degreesToRadians(cfg.lat),
        longitude: satellite.degreesToRadians(cfg.lon),
        height: 0.05,
      };
      const now = new Date();
      const sun = sunEciUnit(now);
      const sunEl = sunElevationDeg(now, observerGd);
      const darkSky = sunEl < -6;

      const overhead = [];
      for (const sat of byId.values()) {
        let satrec;
        try { satrec = satellite.twoline2satrec(sat.l1, sat.l2); } catch { continue; }
        const l = look(satrec, now, observerGd);
        if (!l || l.elevation <= 0) continue;
        const sunlit = isSunlit(l.pos, sun);
        overhead.push({
          name: sat.name,
          norad: sat.norad,
          azimuthDeg: Math.round(l.azimuth),
          direction: compass(l.azimuth),
          elevationDeg: Math.round(l.elevation),
          rangeKm: Math.round(l.rangeKm),
          altitudeKm: Math.round(l.altitudeKm),
          sunlit,
          nakedEyeVisible: sunlit && darkSky && l.elevation >= 10,
        });
      }
      overhead.sort((a, b) => b.elevationDeg - a.elevationDeg);

      const passes = [];
      for (const f of FEATURED) {
        const sat = byId.get(f.norad);
        if (!sat) continue;
        try {
          const satrec = satellite.twoline2satrec(sat.l1, sat.l2);
          passes.push(...computePasses({ ...sat, name: f.name }, satrec, now, observerGd));
        } catch { /* skip bad TLE */ }
      }
      passes.sort((a, b) => a.rise.localeCompare(b.rise));

      return {
        tracked: byId.size,
        sunElevationDeg: Math.round(sunEl),
        darkSky,
        overhead,
        passes: passes.slice(0, 12),
      };
    });
    return json({
      configured: true,
      ...value,
      cached: hit,
      computedAt: new Date().toISOString(),
      attribution: 'TLEs: CelesTrak (celestrak.org); propagation: satellite.js SGP4',
    }, { cors, maxAge: RESULT_TTL_SECONDS });
  } catch (error) {
    return json({ configured: true, overhead: [], passes: [], error: String(error.message || error) }, { status: 502, cors });
  }
}
