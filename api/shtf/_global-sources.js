/**
 * SHTF gauge — global data fetchers. Free, no-key sources only (UCDP is used
 * only when the optional UCDP_ACCESS_TOKEN is set). Every fetcher:
 *   - caches server-side (memory + Upstash when configured) with a TTL sized
 *     to the source's update cadence and rate limits;
 *   - never throws: returns { status: 'live' | 'unavailable', asOf, data, error }.
 *
 * ACLED CAST is deliberately NOT used (retires Nov 30, 2026) and the ACLED
 * API is not required.
 */
import { cached, stale, fetchWithTimeout } from '../local/_shared.js';
import { iso3FromName, iso3FromIso2, isKnownIso3 } from './_countries.js';
import { zScore, logisticFromZ, meanStd } from './_scoring.js';

const UA = 'WorldMonitor-SHTF/1.0 (+https://github.com/ethanmaxwellharris/worldmonitor)';
const HOUR = 3600;
const DAY = 24 * HOUR;

async function getJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function getText(url, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, ...headers } }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wrap a producer so failures degrade to a stale copy or an 'unavailable' result. */
async function source(key, ttl, producer) {
  try {
    const { value, cached: hit } = await cached(key, ttl, producer);
    return { status: 'live', cached: hit, ...value };
  } catch (error) {
    const old = stale(key);
    if (old) return { status: 'live', stale: true, ...old, error: String(error.message || error) };
    return { status: 'unavailable', data: {}, error: String(error.message || error) };
  }
}

/** Minimal CSV line splitter (handles quoted fields). */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// ── 1. ViEWS conflict forecasts (state-based, country-month) ──
export function fetchViews() {
  return source('shtf:views:v1', 12 * HOUR, async () => {
    const index = await getJson('https://api.viewsforecasting.org/', { timeoutMs: 15000 });
    const runs = (index.runs || []).filter((r) => /^fatalities\d+_\d{4}_\d{2}/.test(r)).sort();
    const run = runs[runs.length - 1];
    if (!run) throw new Error('No ViEWS fatalities run listed');
    // Rows are ordered by month; page 1 (1000 rows) covers the first 3+ forecast months for ~191 countries.
    const page = await getJson(`https://api.viewsforecasting.org/${run}/cm/sb?pagesize=1000`, { timeoutMs: 30000 });
    const start = Number(page.start_date);
    const rows = (page.data || []).filter((r) => r.month_id >= start && r.month_id < start + 3);
    const acc = {};
    const gw = {};
    for (const r of rows) {
      const iso3 = r.isoab;
      if (!iso3) continue;
      gw[r.gwcode] = iso3;
      const a = (acc[iso3] ||= { p: [], f: [], name: r.name });
      a.p.push(Number(r.main_dich));
      a.f.push(Number(r.main_mean));
    }
    const data = {};
    for (const [iso3, a] of Object.entries(acc)) {
      data[iso3] = {
        probability: meanStd(a.p).mean,
        fatalities: meanStd(a.f).mean,
      };
    }
    const first = rows[0];
    return {
      data,
      gw,
      run,
      asOf: first ? `${first.year}-${String(first.month).padStart(2, '0')}` : null,
      note: `ViEWS ${run}, forecast months 1–3 (state-based conflict)`,
    };
  });
}

// ── 2. Early Warning Project statistical risk (mass killing, annual) ──
const EWP_DEFAULT_URL =
  'https://raw.githubusercontent.com/EarlyWarningProject/2025-Statistical-Risk-Assessment/HEAD/4.Interpretation/final_forecasts_data_4Sep2025.csv';

export function fetchEwp(gwToIso3 = {}) {
  return source('shtf:ewp:v1', 7 * DAY, async () => {
    const url = (process.env.SHTF_EWP_CSV_URL || '').trim() || EWP_DEFAULT_URL;
    const text = await getText(url, { timeoutMs: 20000 });
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = splitCsvLine(lines[0]);
    const iName = header.indexOf('ewp_name');
    const iRisk = header.findIndex((h) => h.startsWith('risk.'));
    const iCcode = header.indexOf('ccode');
    const data = {};
    for (const line of lines.slice(1)) {
      const cols = splitCsvLine(line);
      const risk = Number.parseFloat(cols[iRisk]);
      if (!Number.isFinite(risk)) continue;
      const iso3 = gwToIso3[cols[iCcode]] || iso3FromName(cols[iName]);
      if (iso3) data[iso3] = { risk };
    }
    return { data, asOf: header[iRisk]?.replace('risk.', '') || null, note: 'EWP statistical risk assessment (2-year mass-killing onset risk)' };
  });
}

// ── 3. World Bank indicators (annual; most recent non-empty value) ──
async function wbIndicator(indicator) {
  const json = await getJson(`https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&mrnev=1&per_page=400`, { timeoutMs: 25000 });
  const rows = Array.isArray(json) ? json[1] || [] : [];
  const out = {};
  for (const r of rows) {
    const iso3 = r.countryiso3code;
    if (!iso3 || !isKnownIso3(iso3) || r.value === null) continue;
    out[iso3] = { value: Number(r.value), year: r.date };
  }
  return out;
}

async function wgiPoliticalStability() {
  for (const yr of ['YR2025', 'YR2024', 'YR2023']) {
    const json = await getJson(`https://api.worldbank.org/v2/sources/3/country/all/series/GOV_WGI_PV.EST/time/${yr}?format=json&per_page=400`, { timeoutMs: 25000 });
    const rows = json?.source?.data || [];
    const out = {};
    for (const r of rows) {
      const iso3 = r.variable?.find((v) => v.concept === 'Country')?.id;
      if (!iso3 || !isKnownIso3(iso3) || r.value === null || r.value === undefined) continue;
      out[iso3] = { value: Number(r.value), year: yr.slice(2) };
    }
    if (Object.keys(out).length > 50) return out;
  }
  return {};
}

export function fetchWorldBank() {
  return source('shtf:worldbank:v1', DAY, async () => {
    const [infantMortality, inflation, foodImports, politicalStability] = await Promise.all([
      wbIndicator('SP.DYN.IMRT.IN'),
      wbIndicator('FP.CPI.TOTL.ZG'),
      wbIndicator('TM.VAL.FOOD.ZS.UN'),
      wgiPoliticalStability().catch(() => ({})),
    ]);
    if (!Object.keys(infantMortality).length && !Object.keys(inflation).length) throw new Error('World Bank returned no data');
    return {
      data: { infantMortality, inflation, foodImports, politicalStability },
      asOf: new Date().toISOString().slice(0, 10),
      note: 'World Bank WDI (infant mortality, CPI inflation, food import share) + WGI political stability',
    };
  });
}

// ── 4. FAO Food Price Index (global, monthly) ──
export function fetchFao() {
  return source('shtf:fao:v1', DAY, async () => {
    const text = await getText('https://www.fao.org/media/docs/worldfoodsituationlibraries/wfs-library/food_price_indices_data.csv?download=true', { timeoutMs: 20000 });
    const rows = text.split(/\r?\n/)
      .map((l) => l.split(','))
      .filter((c) => /^\d{4}-\d{2}$/.test(c[0]) && Number.isFinite(Number.parseFloat(c[1])))
      .map((c) => ({ month: c[0], value: Number.parseFloat(c[1]) }));
    if (rows.length < 4) throw new Error('FAO FFPI CSV had no rows');
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 4];
    return {
      data: { latest: last.value, month: last.month, change3m: ((last.value - prev.value) / prev.value) * 100 },
      asOf: last.month,
      note: `FAO Food Price Index ${last.month} = ${last.value}`,
    };
  });
}

// ── 5. FEWS NET population in IPC Phase 3+ (country level) ──
export function fetchFewsNet() {
  return source('shtf:fewsnet:v1', DAY, async () => {
    const since = new Date(Date.now() - 200 * DAY * 1000).toISOString().slice(0, 10);
    const base = `https://fdw.fews.net/api/ipcpopulationsize.json?phase=3%2B&start_date=${since}&fields=simple&page_size=500`;
    const results = [];
    let url = `${base}&offset=0`;
    // FDW throttles bursts: fetch pages sequentially with a pause, max 3 pages.
    for (let i = 0; i < 3 && url; i++) {
      if (i > 0) await sleep(2500);
      const page = await getJson(url, { timeoutMs: 30000 });
      results.push(...(page.results || []));
      url = page.next;
    }
    const latest = {};
    for (const r of results) {
      const iso3 = iso3FromIso2(r.country_code);
      if (!iso3 || r.admin_1) continue; // country totals only
      const lo = Number(r.pct_population_min);
      const hi = Number(r.pct_population_max);
      if (!Number.isFinite(lo) && !Number.isFinite(hi)) continue;
      const pct = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : (Number.isFinite(hi) ? hi : lo);
      const date = r.projection_start || r.reporting_date;
      const cur = latest[iso3];
      if (!cur || date > cur.date || (date === cur.date && pct > cur.pct)) latest[iso3] = { pct, date, scenario: r.scenario };
    }
    if (!Object.keys(latest).length) throw new Error('FEWS NET returned no country totals');
    return { data: latest, asOf: since, note: 'FEWS NET share of population in IPC Phase 3+ (country totals)' };
  });
}

// ── 6. GDACS orange/red alerts, last 30 days ──
export function fetchGdacs() {
  return source('shtf:gdacs:v1', HOUR, async () => {
    const to = new Date();
    const from = new Date(Date.now() - 30 * DAY * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const json = await getJson(
      `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&fromDate=${fmt(from)}&toDate=${fmt(to)}&alertlevel=Orange;Red&pagesize=100`,
      { timeoutMs: 20000 },
    );
    const events = [];
    for (const f of json.features || []) {
      const p = f.properties || {};
      const isos = (p.affectedcountries || []).map((c) => c.iso3).filter(Boolean);
      if (!isos.length && p.iso3) isos.push(p.iso3);
      events.push({
        name: p.name || p.eventname,
        type: p.eventtype,
        alertLevel: p.alertlevel,
        toDate: p.todate,
        iso3: [...new Set(isos)],
        url: p.url?.report || null,
      });
    }
    return { data: { events }, asOf: to.toISOString(), note: `${events.length} GDACS orange/red alerts in 30 days` };
  });
}

// ── 7. BIS credit-to-GDP gap + debt service ratio (quarterly, ~44 economies) ──
function parseBisCsv(text, valueCol = 'OBS_VALUE') {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0]);
  const iCty = header.indexOf('BORROWERS_CTY');
  const iT = header.indexOf('TIME_PERIOD');
  const iV = header.indexOf(valueCol);
  const series = {};
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l);
    const v = Number.parseFloat(c[iV]);
    if (!Number.isFinite(v)) continue;
    (series[c[iCty]] ||= []).push({ t: c[iT], v });
  }
  for (const s of Object.values(series)) s.sort((a, b) => a.t.localeCompare(b.t));
  return series;
}

export function fetchBis() {
  return source('shtf:bis:v1', DAY, async () => {
    const [gapText, dsrText] = await Promise.all([
      getText('https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CREDIT_GAP/1.0/Q..P.A.C?lastNObservations=1&format=csv', { timeoutMs: 25000 }),
      getText('https://stats.bis.org/api/v2/data/dataflow/BIS/WS_DSR/1.0/Q..P?lastNObservations=80&format=csv', { timeoutMs: 25000 }),
    ]);
    const gap = parseBisCsv(gapText);
    const dsr = parseBisCsv(dsrText);
    const data = {};
    let asOf = null;
    for (const [iso2, s] of Object.entries(gap)) {
      const iso3 = iso3FromIso2(iso2);
      if (!iso3 || !s.length) continue;
      const last = s[s.length - 1];
      (data[iso3] ||= {}).creditGap = last.v;
      data[iso3].creditGapPeriod = last.t;
      asOf = !asOf || last.t > asOf ? last.t : asOf;
    }
    for (const [iso2, s] of Object.entries(dsr)) {
      const iso3 = iso3FromIso2(iso2);
      if (!iso3 || s.length < 12) continue;
      const last = s[s.length - 1];
      const hist = meanStd(s.slice(0, -1).map((x) => x.v));
      (data[iso3] ||= {}).dsrDeviation = last.v - hist.mean;
      data[iso3].dsr = last.v;
      data[iso3].dsrPeriod = last.t;
    }
    return { data, asOf, note: 'BIS credit-to-GDP gap and private non-financial debt service ratio' };
  });
}

// GDELT asks for ≤1 request per 5 s. Serialize calls per isolate and back off after a 429.
let gdeltChain = Promise.resolve();
let gdeltLastAt = 0;
let gdeltBackoffUntil = 0;
export function gdeltGetJson(url) {
  const run = async () => {
    if (Date.now() < gdeltBackoffUntil) throw new Error('GDELT rate-limited; backing off');
    const wait = gdeltLastAt + 6000 - Date.now();
    if (wait > 0) await sleep(wait);
    gdeltLastAt = Date.now();
    try {
      return await getJson(url, { timeoutMs: 45000 });
    } catch (e) {
      if (/HTTP 429/.test(String(e.message))) gdeltBackoffUntil = Date.now() + 10 * 60 * 1000;
      throw e;
    }
  };
  const p = gdeltChain.then(run, run);
  gdeltChain = p.catch(() => {});
  return p;
}

// ── 8. GDELT protest/riot coverage intensity vs own 90-day baseline ──
/**
 * One request returns daily "volume intensity" (share of a country's own
 * media coverage matching protest/riot terms) for ~150 source countries.
 * Score: z of the last 7-day mean vs prior non-overlapping weekly means.
 * Evidence is WEAK (Wang et al. 2016): used at half confidence.
 */
export function gdeltCountryZ(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 35) return null;
  const current = meanStd(v.slice(-7)).mean;
  const weeks = [];
  for (let end = v.length - 7; end - 7 >= 0; end -= 7) weeks.push(meanStd(v.slice(end - 7, end)).mean);
  return zScore(current, weeks, { minN: 4 });
}

export function fetchGdeltMobilisation() {
  return source('shtf:gdelt-mobilisation:v1', 6 * HOUR, async () => {
    const q = encodeURIComponent('(protest OR riot OR demonstrators OR clashes)');
    const json = await gdeltGetJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=timelinesourcecountry&timespan=90d&format=json`);
    const data = {};
    let asOf = null;
    for (const s of json.timeline || []) {
      const name = String(s.series || '').replace(/\s*Volume Intensity$/i, '').trim();
      const iso3 = iso3FromName(name);
      if (!iso3) continue;
      const vals = (s.data || []).map((d) => Number(d.value));
      const z = gdeltCountryZ(vals);
      if (z === null) continue;
      data[iso3] = { z, score: logisticFromZ(z) };
      const lastDate = s.data?.[s.data.length - 1]?.date;
      if (lastDate && (!asOf || lastDate > asOf)) asOf = lastDate;
    }
    if (!Object.keys(data).length) throw new Error('GDELT returned no usable series');
    return { data, asOf: asOf ? `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}` : null, note: 'GDELT DOC protest/riot coverage share, last 7 days vs prior 12 weeks' };
  });
}

// ── 9. UCDP conflict history floor (optional; needs a free UCDP token) ──
export function fetchUcdpFloor() {
  const token = (process.env.UCDP_ACCESS_TOKEN || '').trim();
  if (!token) return Promise.resolve({ status: 'unavailable', data: {}, error: 'UCDP_ACCESS_TOKEN not set (UCDP API now requires a free token); using ViEWS-forecast floor proxy' });
  return source('shtf:ucdp-floor:v1', DAY, async () => {
    const rows = [];
    for (let page = 1; page <= 5; page++) {
      const json = await getJson(`https://ucdpapi.pcr.uu.se/api/ucdpprioconflict/25.1?pagesize=1000&page=${page}`, { headers: { 'x-ucdp-access-token': token } });
      rows.push(...(json.Result || []));
      if (!json.NextPageUrl) break;
    }
    const maxYear = rows.reduce((m, r) => Math.max(m, Number(r.year) || 0), 0);
    const data = {};
    for (const r of rows) {
      if (Number(r.year) !== maxYear) continue;
      for (const loc of String(r.location || '').split(',')) {
        const iso3 = iso3FromName(loc.trim());
        if (!iso3) continue;
        const intensity = Number(r.intensity_level) === 2 ? 'war' : 'minor';
        if (data[iso3] !== 'war') data[iso3] = intensity;
      }
    }
    return { data, asOf: String(maxYear), note: `UCDP/PRIO armed conflict ${maxYear}` };
  });
}
