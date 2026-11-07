/**
 * GET /api/local/gauge
 * Local SHTF "temperature" (0–100) for the home county (US only), built from
 * free sources: NWS alerts, FAA airport status, EIA grid (optional free key),
 * CDC NWSS wastewater, DOL weekly jobless claims, GDELT (weak), OpenFEMA and
 * NOAA SWPC. Missing sources are re-weighted away and widen the band.
 *
 * Privacy: home coordinates come only from server env (LOCAL_LAT/LOCAL_LON).
 * The response names the county/state but carries NO coordinates; it is
 * private/no-store (never cached on a shared CDN). Server-side cache keys use
 * the county FIPS, not the point.
 *
 * Not a prediction: relative to this county's own recent baseline and to
 * national context. The US national temperature is fetched separately from
 * /api/shtf/gauge?iso3=USA and is never summed with this score.
 */
import { preamble, json, cached, fetchWithTimeout } from './_shared.js';
import { getPoint, getCountyName, getAlerts } from './weather.js';
import { STATES, STATE_AIRPORTS, STATE_GRID_REGION } from './_us.js';
import {
  LOCAL_PILLARS, combinePillars, levelFor, round1, averageAvailable,
  nwsSeverityScore, wastewaterCategoryScore, kpScore, femaScore, logisticFromZ, zScore, meanStd,
} from '../shtf/_scoring.js';
import { gdeltCountryZ, splitCsvLine, gdeltGetJson } from '../shtf/_global-sources.js';

export const config = { runtime: 'edge' };

const HOUR = 3600;
const DAY = 24 * HOUR;
const UNREST_GDELT_CONFIDENCE = 0.5;
const r1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? round1(n) : null);

async function getJson(url, cfg, timeoutMs = 15000, headers = {}) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json', ...headers } }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}
async function getText(url, cfg, timeoutMs = 20000) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': cfg.userAgent } }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

/** Runs a pillar component; never throws. */
async function attempt(id, fn) {
  try {
    const r = await fn();
    return r ? { id, status: 'live', ...r } : { id, status: 'unavailable', error: 'no data' };
  } catch (e) {
    return { id, status: 'unavailable', error: String(e?.message || e) };
  }
}

// ── Area resolution: NWS point → county zone (e.g. NYC061) → FIPS ──
async function resolveArea(cfg) {
  const point = await getPoint(cfg);
  if (!point.supported) return null;
  const zone = String(point.countyUrl || '').split('/').pop() || '';
  const m = zone.match(/^([A-Z]{2})C(\d{3})$/);
  const stateAbbr = m?.[1] || point.state;
  const st = STATES[stateAbbr];
  const county = await getCountyName(point, cfg).catch(() => null);
  return {
    state: stateAbbr,
    stateName: st?.[1] || stateAbbr,
    stateFips: st?.[0] || null,
    countyFips: st && m ? `${st[0]}${m[2]}` : null,
    countyCode3: m?.[2] || null,
    county: county?.name || null,
    zone,
  };
}

// ── Pillar fetchers ──
async function hazardsNow(cfg) {
  const alerts = await getAlerts(cfg);
  const score = nwsSeverityScore(alerts.map((a) => a.severity));
  const top = alerts.slice().sort((a, b) => nwsSeverityScore([b.severity]) - nwsSeverityScore([a.severity])).slice(0, 3);
  return {
    score,
    components: [{ id: 'nws', label: 'Active NWS alerts at home point (max severity)', value: alerts.length ? top.map((a) => `${a.event} (${a.severity})`).join('; ') : 'none active', score }],
    asOf: new Date().toISOString(),
    source: 'NWS api.weather.gov',
  };
}

function parseFaaXml(xml) {
  const items = [];
  const re = /<(Ground_Delay|Ground_Stop|Delay)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const arpt = body.match(/<ARPT>([^<]+)<\/ARPT>/)?.[1]?.trim();
    if (!arpt) continue;
    const reason = body.match(/<Reason>([^<]+)<\/Reason>/)?.[1]?.trim() || '';
    const maxMin = body.match(/<Max>(\d+)\s*minutes?/i)?.[1] || body.match(/<Avg>(\d+)\s*minutes?/i)?.[1];
    items.push({ type: m[1], arpt, reason, minutes: maxMin ? Number(maxMin) : null });
  }
  return items;
}

export function faaScore(items) {
  let best = 0;
  for (const i of items) {
    const s = i.type === 'Ground_Stop' ? 80 : i.type === 'Ground_Delay' ? 60 : (i.minutes ?? 0) >= 45 ? 40 : 20;
    best = Math.max(best, s);
  }
  return best;
}

async function infrastructure(cfg, area) {
  const comps = [];
  const airports = STATE_AIRPORTS[area.state] || [];
  const faa = await attempt('faa', async () => {
    const { value } = await cached('local:shtf:faa:v1', 5 * 60, async () => parseFaaXml(await getText('https://nasstatus.faa.gov/api/airport-status-information', cfg, 12000)));
    const mine = value.filter((i) => airports.includes(i.arpt));
    return { score: faaScore(mine), value: mine.length ? mine.map((i) => `${i.arpt} ${i.type.replace('_', ' ')}${i.minutes ? ` ${i.minutes}m` : ''}`).join('; ') : `no programs at ${airports.slice(0, 4).join('/') || 'state airports'}` };
  });
  if (faa.status === 'live') comps.push({ id: 'faa', label: 'FAA ground stops / delay programs at state hub airports', value: faa.value, score: faa.score });

  const eiaKey = (process.env.EIA_API_KEY || '').trim();
  const region = STATE_GRID_REGION[area.state];
  let eiaStatus = { status: 'unavailable', error: eiaKey ? 'no grid region for state' : 'EIA_API_KEY not set (free key) — grid demand vs forecast skipped' };
  if (eiaKey && region) {
    eiaStatus = await attempt('eia', async () => {
      const { value } = await cached(`local:shtf:eia-grid:v1:${region}`, 30 * 60, async () => {
        const url = `https://api.eia.gov/v2/electricity/rto/region-data/data/?api_key=${encodeURIComponent(eiaKey)}&frequency=hourly&data[0]=value&facets[respondent][]=${region}&facets[type][]=D&facets[type][]=DF&sort[0][column]=period&sort[0][direction]=desc&length=48`;
        const rows = (await getJson(url, cfg, 15000)).response?.data || [];
        const byPeriod = {};
        for (const r of rows) (byPeriod[r.period] ||= {})[r.type] = Number(r.value);
        const latest = Object.entries(byPeriod).sort((a, b) => b[0].localeCompare(a[0])).find(([, v]) => Number.isFinite(v.D) && Number.isFinite(v.DF));
        if (!latest) return null;
        const [period, v] = latest;
        return { period, demand: v.D, forecast: v.DF, pct: ((v.D - v.DF) / v.DF) * 100 };
      });
      if (!value) return null;
      // Demand running well above day-ahead forecast = stress. +10% → ~100.
      const score = Math.max(0, Math.min(100, value.pct * 10));
      return { score, value: `${region} demand ${r1(value.pct)}% vs day-ahead forecast (${value.period} UTC)` };
    });
  }
  if (eiaStatus.status === 'live') comps.push({ id: 'eia', label: 'Grid demand vs day-ahead forecast (EIA)', value: eiaStatus.value, score: eiaStatus.score });

  return {
    score: averageAvailable(comps.map((c) => c.score)),
    components: comps,
    source: 'FAA NAS Status; EIA Open Data (optional key)',
    notes: [eiaStatus.status !== 'live' ? `EIA: ${eiaStatus.error}` : null, 'Cloudflare Radar outages and PowerOutage.us need keys/paid plans: not used.'].filter(Boolean),
  };
}

async function health(cfg, area) {
  const { value } = await cached(`local:shtf:nwss:v1:${area.state}`, 6 * HOUR, async () => {
    const latest = await getJson(`https://data.cdc.gov/resource/atcp-73re.json?$select=max(week_end)&$where=${encodeURIComponent(`state_territory='${area.stateName}'`)}`, cfg);
    const week = latest?.[0]?.max_week_end;
    if (!week) return null;
    const rows = await getJson(`https://data.cdc.gov/resource/atcp-73re.json?$limit=2000&$where=${encodeURIComponent(`state_territory='${area.stateName}' AND week_end='${week}'`)}`, cfg);
    return { week: week.slice(0, 10), rows: rows.map((r) => ({ counties: r.counties_served || '', pathogen: r.pathogen_target, category: r.site_wval_category })) };
  });
  if (!value || !value.rows.length) return null;
  const countyName = (area.county || '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
  const local = countyName ? value.rows.filter((r) => r.counties.toLowerCase().split(/,\s*/).includes(countyName)) : [];
  const rows = local.length ? local : value.rows;
  const byPathogen = {};
  for (const r of rows) {
    const s = wastewaterCategoryScore(r.category);
    if (s === null) continue;
    (byPathogen[r.pathogen] ||= []).push(s);
  }
  const components = Object.entries(byPathogen).map(([pathogen, scores]) => {
    const sorted = scores.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { id: `nwss-${pathogen}`, label: `${pathogen} wastewater viral activity (${local.length ? 'county' : 'state'} sites, median)`, value: `${sorted.length} site(s)`, score: median };
  });
  if (!components.length) return null;
  return { score: Math.max(...components.map((c) => c.score)), components, asOf: value.week, source: 'CDC NWSS (data.cdc.gov atcp-73re)', scope: local.length ? 'county' : 'state' };
}

/** DOL ETA 539 weekly initial claims: 4-week mean vs same weeks in the prior 3 years. */
export function claimsZ(series) {
  if (series.length < 160) return null;
  const last = series[series.length - 1];
  const cur = meanStd(series.slice(-4).map((s) => s.v)).mean;
  const lastDate = new Date(last.t);
  const baseline = [];
  for (let y = 1; y <= 3; y++) {
    const target = new Date(lastDate);
    target.setUTCFullYear(target.getUTCFullYear() - y);
    const window = series.filter((s) => Math.abs(Date.parse(s.t) - target.getTime()) <= 4 * 7 * 86400000 + 3 * 86400000);
    // 4-week rolling means inside the ±4-week seasonal window
    for (let i = 3; i < window.length; i++) baseline.push(meanStd(window.slice(i - 3, i + 1).map((s) => s.v)).mean);
  }
  return { z: zScore(cur, baseline, { minN: 6 }), current: cur, week: last.t };
}

async function economy(cfg, area) {
  const comps = [];
  const notes = [];
  const claims = await attempt('dol', async () => {
    const { value } = await cached(`local:shtf:dol-claims:v1:${area.state}`, 12 * HOUR, async () => {
      const text = await getText('https://oui.doleta.gov/unemploy/csv/ar539.csv', cfg, 25000);
      const series = [];
      const prefix = `"${area.state}",`;
      for (const line of text.split('\n')) {
        if (!line.startsWith(prefix)) continue;
        const c = splitCsvLine(line);
        const v = Number(c[4]);
        if (Number.isFinite(v)) series.push({ t: c[1], v });
      }
      series.sort((a, b) => a.t.localeCompare(b.t));
      return series.slice(-260); // ~5 years
    });
    const r = claimsZ(value);
    if (!r || r.z === null) return null;
    return { score: logisticFromZ(r.z), value: `${Math.round(r.current).toLocaleString('en-US')}/wk (4-wk avg), z=${r1(r.z)} vs same weeks ${Number(r.week.slice(0, 4)) - 3}–${String(Number(r.week.slice(0, 4)) - 1).slice(2)}`, asOf: r.week };
  });
  if (claims.status === 'live') comps.push({ id: 'claims', label: `${area.stateName} initial jobless claims vs 3-yr same-season baseline`, value: claims.value, score: r1(claims.score) });
  else notes.push(`DOL claims: ${claims.error}`);

  const eiaKey = (process.env.EIA_API_KEY || '').trim();
  if (eiaKey) {
    const gas = await attempt('gas', async () => {
      const { value } = await cached('local:shtf:eia-gas:v1', 12 * HOUR, async () => {
        const url = `https://api.eia.gov/v2/seriesid/PET.EMM_EPMR_PTE_NUS_DPG.W?api_key=${encodeURIComponent(eiaKey)}&length=160`;
        const rows = (await getJson(url, cfg, 15000)).response?.data || [];
        return rows.map((r) => ({ t: r.period, v: Number(r.value) })).filter((r) => Number.isFinite(r.v)).sort((a, b) => a.t.localeCompare(b.t));
      });
      if (value.length < 60) return null;
      const cur = value[value.length - 1];
      const z = zScore(cur.v, value.slice(-157, -1).map((r) => r.v), { minN: 20 });
      return { score: logisticFromZ(z), value: `$${cur.v.toFixed(2)}/gal (US regular), z=${r1(z)} vs 3 yrs`, asOf: cur.t };
    });
    if (gas.status === 'live') comps.push({ id: 'gas', label: 'Retail gasoline price vs 3-yr baseline (EIA)', value: gas.value, score: r1(gas.score) });
  } else {
    notes.push('Gasoline: EIA_API_KEY not set (free key) — skipped');
  }
  return { score: averageAvailable(comps.map((c) => c.score)), components: comps, asOf: claims.asOf || null, source: 'US DOL ETA 539; EIA (optional key)', notes };
}

async function unrest(cfg, area) {
  const { value } = await cached(`local:shtf:gdelt-unrest:v1:${area.state}`, 6 * HOUR, async () => {
    const q = encodeURIComponent(`(protest OR riot OR demonstrators) "${area.stateName}" sourcecountry:US`);
    const js = await gdeltGetJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=timelinevolraw&timespan=90d&format=json`);
    const data = js.timeline?.[0]?.data || [];
    return data.map((d) => (d.norm ? (Number(d.value) / Number(d.norm)) * 1e5 : Number(d.value)));
  });
  const z = gdeltCountryZ(value);
  if (z === null) return null;
  const score = logisticFromZ(z);
  return {
    score,
    confidence: UNREST_GDELT_CONFIDENCE,
    components: [{ id: 'gdelt', label: `Protest/riot news mentioning ${area.stateName}, 7 days vs own 12-week baseline (z)`, value: r1(z), score: r1(score) }],
    source: 'GDELT DOC 2.0 (weak evidence, half weight)',
  };
}

async function declarations(cfg, area) {
  if (!area.countyCode3) return null;
  const { value } = await cached(`local:shtf:fema:v1:${area.countyFips}`, 6 * HOUR, async () => {
    const since = new Date(Date.now() - 180 * DAY * 1000).toISOString().slice(0, 10);
    const filter = `state eq '${area.state}' and fipsCountyCode eq '${area.countyCode3}' and declarationDate ge '${since}'`;
    const js = await getJson(`https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=${encodeURIComponent(filter)}&$orderby=declarationDate%20desc&$top=20`, cfg);
    return (js.DisasterDeclarationsSummaries || []).map((d) => ({ id: d.femaDeclarationString, title: d.declarationTitle, date: d.declarationDate, end: d.incidentEndDate, type: d.incidentType }));
  });
  const open = value.filter((d) => !d.end || Date.parse(d.end) > Date.now() - 90 * DAY * 1000);
  const daysAgo = open[0] ? (Date.now() - Date.parse(open[0].date)) / 86400000 : null;
  const score = femaScore(open.length, daysAgo);
  return {
    score,
    components: [{ id: 'fema', label: 'FEMA declarations covering the county (last 180 days, lagging)', value: open.length ? open.map((d) => `${d.id} ${d.title}`).join('; ') : 'none', score }],
    source: 'OpenFEMA',
  };
}

async function spaceWeather(cfg) {
  const { value } = await cached('local:shtf:swpc-kp:v1', 15 * 60, async () => {
    const rows = await getJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', cfg, 10000);
    // Newer format: array of objects; legacy: header row + arrays.
    const parsed = rows.map((r) => (Array.isArray(r) ? { t: r[0], kp: Number(r[1]) } : { t: r.time_tag, kp: Number(r.Kp) })).filter((r) => Number.isFinite(r.kp));
    return parsed.slice(-8); // last 24 h (3-hourly)
  });
  if (!value.length) return null;
  const maxKp = Math.max(...value.map((r) => r.kp));
  const score = kpScore(maxKp);
  return {
    score,
    components: [{ id: 'kp', label: 'Planetary Kp, max over last 24 h (G3+ raises grid risk)', value: r1(maxKp), score: r1(score) }],
    asOf: value[value.length - 1].t,
    source: 'NOAA SWPC',
  };
}

export default async function handler(request) {
  const pre = preamble(request);
  if (pre.response) return pre.response;
  const { cors, cfg } = pre;

  try {
    const area = await resolveArea(cfg);
    if (!area) {
      return json({ configured: true, supported: false, reason: 'The local gauge uses US federal data (NWS, FEMA, CDC, DOL); non-US locations are not supported yet.' }, { cors });
    }

    const [hz, infra, hl, econ, unr, decl, sw] = await Promise.all([
      attempt('hazards', () => hazardsNow(cfg)),
      attempt('infrastructure', () => infrastructure(cfg, area)),
      attempt('health', () => health(cfg, area)),
      attempt('economy', () => economy(cfg, area)),
      attempt('unrest', () => unrest(cfg, area)),
      attempt('declarations', () => declarations(cfg, area)),
      attempt('spaceWeather', () => spaceWeather(cfg)),
    ]);
    const results = { hazards: hz, infrastructure: infra, health: hl, economy: econ, unrest: unr, declarations: decl, spaceWeather: sw };

    const pillarInputs = [];
    const pillars = LOCAL_PILLARS.map((p) => {
      const r = results[p.id];
      const score = r.status === 'live' && typeof r.score === 'number' ? r.score : null;
      const confidence = r.confidence ?? 1;
      const eff = score === null ? 0 : p.weight * confidence;
      pillarInputs.push({ id: p.id, weight: score === null ? p.weight : eff, score });
      if (score !== null && confidence < 1) pillarInputs.push({ id: `${p.id}-unfilled`, weight: p.weight - eff, score: null });
      return {
        id: p.id,
        label: p.label,
        weight: p.weight,
        effectiveWeight: eff,
        score: r1(score),
        status: score === null ? 'unavailable' : 'live',
        components: r.components || [],
        asOf: r.asOf || null,
        source: r.source || null,
        scope: r.scope || null,
        notes: [...(r.notes || []), ...(r.status !== 'live' ? [r.error] : [])].filter(Boolean),
      };
    });

    const combined = combinePillars(pillarInputs);
    const t = combined.temperature;
    const drivers = pillars
      .filter((p) => p.score !== null && p.effectiveWeight > 0)
      .map((p) => ({ label: p.label, c: p.effectiveWeight * p.score }))
      .sort((a, b) => b.c - a.c)
      .slice(0, 3)
      .map((d) => d.label);

    return json({
      configured: true,
      supported: true,
      area: { county: area.county, state: area.state, stateName: area.stateName, countyFips: area.countyFips },
      t: r1(t),
      band: r1(combined.band),
      lo: t === null ? null : r1(Math.max(0, t - combined.band)),
      hi: t === null ? null : r1(Math.min(100, t + combined.band)),
      level: levelFor(t),
      coverage: combined.coverage,
      drivers,
      pillars,
      method: {
        formula: 'T = Σ w·S / Σ w over pillars with data; band = σ(pillars)/√n + 25 × missing weight share',
        notes: [
          'Relative to this county’s own recent baseline. Not a prediction that anything will happen.',
          'Shown beside the US national temperature, never added to it.',
          'GDELT unrest is weak evidence and fills only half of its pillar.',
        ],
      },
      generatedAt: new Date().toISOString(),
    }, { cors, maxAge: 0 });
  } catch (error) {
    return json({ configured: true, error: String(error?.message || error) }, { status: 502, cors });
  }
}
