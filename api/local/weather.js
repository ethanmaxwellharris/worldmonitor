/**
 * GET /api/local/weather
 * NWS (api.weather.gov) active alerts + 7-day forecast for the home point.
 * Free, no key; NWS asks for a descriptive User-Agent with contact info
 * (override with LOCAL_USER_AGENT). US locations only: non-US points return
 * configured:true with supported:false.
 *
 * Cache: /points metadata 24 h, forecast 30 min, alerts 2 min.
 */
import { preamble, json, cached, stale, fetchWithTimeout } from './_shared.js';

export const config = { runtime: 'edge' };

function nwsFetch(url, cfg) {
  return fetchWithTimeout(url, {
    headers: { 'User-Agent': cfg.userAgent, Accept: 'application/geo+json' },
  }, 10000);
}

export async function getPoint(cfg) {
  const pt = `${cfg.lat.toFixed(4)},${cfg.lon.toFixed(4)}`;
  const { value } = await cached(`local:nws:point:v1:${pt}`, 24 * 3600, async () => {
    const res = await nwsFetch(`https://api.weather.gov/points/${pt}`, cfg);
    if (res.status === 404) return { supported: false };
    if (!res.ok) throw new Error(`NWS points HTTP ${res.status}`);
    const p = (await res.json()).properties || {};
    return {
      supported: true,
      forecastUrl: p.forecast || null,
      forecastHourlyUrl: p.forecastHourly || null,
      office: p.cwa || p.gridId || null,
      city: p.relativeLocation?.properties?.city || null,
      state: p.relativeLocation?.properties?.state || null,
      countyUrl: p.county || null,
      timeZone: p.timeZone || null,
      radarStation: p.radarStation || null,
    };
  });
  return value;
}

export async function getCountyName(point, cfg) {
  if (!point.countyUrl) return null;
  const { value } = await cached(`local:nws:county:v1:${point.countyUrl}`, 7 * 24 * 3600, async () => {
    const res = await nwsFetch(point.countyUrl, cfg);
    if (!res.ok) return null;
    const p = (await res.json()).properties || {};
    return p.name ? { name: p.name, state: p.state || null } : null;
  }).catch(() => ({ value: null }));
  return value;
}

async function getForecast(point, cfg) {
  if (!point.forecastUrl) return [];
  const key = `local:nws:forecast:v1:${point.forecastUrl}`;
  try {
    const { value } = await cached(key, 30 * 60, async () => {
      const res = await nwsFetch(point.forecastUrl, cfg);
      if (!res.ok) throw new Error(`NWS forecast HTTP ${res.status}`);
      const periods = (await res.json()).properties?.periods || [];
      return periods.slice(0, 8).map((p) => ({
        name: p.name,
        startTime: p.startTime,
        isDaytime: p.isDaytime,
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        precipitationChance: p.probabilityOfPrecipitation?.value ?? null,
        wind: [p.windSpeed, p.windDirection].filter(Boolean).join(' '),
        shortForecast: p.shortForecast,
        icon: p.icon,
      }));
    });
    return value;
  } catch {
    return stale(key) || [];
  }
}

export async function getAlerts(cfg) {
  const pt = `${cfg.lat.toFixed(4)},${cfg.lon.toFixed(4)}`;
  const { value } = await cached(`local:nws:alerts:v1:${pt}`, 120, async () => {
    const res = await nwsFetch(`https://api.weather.gov/alerts/active?point=${pt}`, cfg);
    if (!res.ok) throw new Error(`NWS alerts HTTP ${res.status}`);
    const features = (await res.json()).features || [];
    return features.map((f) => {
      const p = f.properties || {};
      return {
        id: p.id,
        event: p.event,
        severity: p.severity,
        urgency: p.urgency,
        certainty: p.certainty,
        headline: p.headline,
        areaDesc: p.areaDesc,
        effective: p.effective,
        expires: p.expires,
        senderName: p.senderName,
        instruction: p.instruction ? String(p.instruction).slice(0, 600) : null,
        url: p['@id'] || null,
      };
    });
  });
  return value;
}

export default async function handler(request) {
  const pre = preamble(request);
  if (pre.response) return pre.response;
  const { cors, cfg } = pre;

  try {
    const point = await getPoint(cfg);
    if (!point.supported) {
      return json({ configured: true, supported: false, reason: 'NWS covers US locations only', alerts: [], forecast: [] }, { cors, maxAge: 3600 });
    }
    const [alerts, forecast, county] = await Promise.all([
      getAlerts(cfg).catch((e) => ({ error: String(e.message || e) })),
      getForecast(point, cfg),
      getCountyName(point, cfg),
    ]);
    return json({
      configured: true,
      supported: true,
      location: { city: point.city, state: point.state, county: county?.name || null, office: point.office, timeZone: point.timeZone, radarStation: point.radarStation },
      alerts: Array.isArray(alerts) ? alerts : [],
      alertsError: Array.isArray(alerts) ? undefined : alerts.error,
      forecast,
      fetchedAt: new Date().toISOString(),
      attribution: 'Data: NOAA National Weather Service',
    }, { cors, maxAge: 60 });
  } catch (error) {
    return json({ configured: true, alerts: [], forecast: [], error: String(error.message || error) }, { status: 502, cors });
  }
}
