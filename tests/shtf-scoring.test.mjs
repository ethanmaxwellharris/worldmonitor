/**
 * SHTF gauge tests: scoring/normalization (pure) + local route privacy (fetch mocked, offline).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_PILLARS, LOCAL_PILLARS, logisticFromZ, zScore, viewsScore, percentileRanks, combinePillars,
  applyFloor, floorFromViews, levelFor, trendFor, ipcShareScore, inflationScore, foodImportPressureScore,
  gdacsEventScore, creditGapScore, dsrScore, nwsSeverityScore, wastewaterCategoryScore, kpScore, femaScore,
} from '../api/shtf/_scoring.js';
import { scoreCountries, MOBILISATION_GDELT_CONFIDENCE } from '../api/shtf/_global-score.js';
import { gdeltCountryZ, splitCsvLine } from '../api/shtf/_global-sources.js';
import { iso3FromName, iso3FromIso2 } from '../api/shtf/_countries.js';

const near = (a, b, eps = 0.5) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('pillar weights sum to 100 and match the design', () => {
  assert.equal(GLOBAL_PILLARS.reduce((a, p) => a + p.weight, 0), 100);
  assert.equal(LOCAL_PILLARS.reduce((a, p) => a + p.weight, 0), 100);
  assert.deepEqual(GLOBAL_PILLARS.map((p) => p.weight), [30, 20, 20, 15, 10, 5]);
});

test('logistic squash: z=1.5 → 50, z=3 → ~90, monotonic', () => {
  near(logisticFromZ(1.5), 50, 1e-9);
  near(logisticFromZ(3), 90.5, 0.5);
  assert.ok(logisticFromZ(0) < 15);
  assert.ok(logisticFromZ(-1) < logisticFromZ(0));
  assert.equal(logisticFromZ(null), null);
});

test('zScore needs a baseline and floors σ', () => {
  assert.equal(zScore(5, [1, 2]), null, 'too short');
  near(zScore(14, [10, 10, 10, 10, 10]), 4, 1e-9, 'σ floored at 10% of mean');
  near(zScore(12, [8, 10, 12, 10]), 1.22, 0.01);
});

test('viewsScore = 50% probability + 50% log fatalities, capped', () => {
  assert.equal(viewsScore(1, 1000), 100);
  near(viewsScore(0, 0), 0);
  near(viewsScore(0.5, 0), 25);
  near(viewsScore(1, 5000), 100);
  near(viewsScore(null, 1000), 100);
  assert.equal(viewsScore(null, null), null);
});

test('percentileRanks: ties share rank, inversion works', () => {
  const r = percentileRanks({ A: 1, B: 2, C: 2, D: 3 });
  assert.equal(r.A, 0); assert.equal(r.D, 100); assert.equal(r.B, r.C); near(r.B, 50);
  const inv = percentileRanks({ A: 1, B: 3 }, { higherIsWorse: false });
  assert.equal(inv.A, 100); assert.equal(inv.B, 0);
});

test('combinePillars renormalizes over available pillars and widens the band for missing data', () => {
  const all = combinePillars([{ id: 'a', weight: 50, score: 60 }, { id: 'b', weight: 50, score: 60 }]);
  assert.equal(all.temperature, 60);
  assert.equal(all.band, 0);
  assert.equal(all.coverage, 1);
  const missing = combinePillars([{ id: 'a', weight: 50, score: 60 }, { id: 'b', weight: 50, score: null }]);
  assert.equal(missing.temperature, 60, 'missing is NOT treated as zero');
  assert.equal(missing.coverage, 0.5);
  near(missing.band, 12.5, 1e-9, '25 × missing share');
  const spread = combinePillars([{ id: 'a', weight: 50, score: 20 }, { id: 'b', weight: 50, score: 80 }]);
  assert.equal(spread.temperature, 50);
  near(spread.band, 30 / Math.SQRT2, 1e-6, 'σ/√n');
  const tooLittle = combinePillars([{ id: 'a', weight: 10, score: 90 }, { id: 'b', weight: 90, score: null }]);
  assert.equal(tooLittle.temperature, null, 'below minimum coverage');
});

test('floors and levels match the CII', () => {
  assert.equal(applyFloor(30, 'war').temperature, 70);
  assert.equal(applyFloor(30, 'minor').temperature, 50);
  assert.equal(applyFloor(80, 'minor').temperature, 80);
  assert.equal(applyFloor(30, null).floor, null);
  assert.equal(floorFromViews(100, 1), 'war');
  assert.equal(floorFromViews(3, 0.9), 'minor');
  assert.equal(floorFromViews(3, 0.1), null);
  assert.deepEqual([10, 25, 40, 55, 70].map(levelFor), ['low', 'normal', 'elevated', 'high', 'critical']);
  assert.equal(levelFor(null), 'unknown');
});

test('trend only shows warming/cooling when the change exceeds the band', () => {
  assert.equal(trendFor(50, 45, 8).trend, 'steady');
  assert.equal(trendFor(60, 45, 8).trend, 'warming');
  assert.equal(trendFor(30, 45, 8).trend, 'cooling');
  assert.equal(trendFor(30, null, 8).trend, null);
});

test('indicator mappings are bounded and monotonic', () => {
  near(ipcShareScore(15), 63.2, 0.2);
  assert.ok(ipcShareScore(30) > ipcShareScore(5));
  assert.equal(inflationScore(1), 0);
  near(inflationScore(10), 41.1, 0.3);
  assert.equal(inflationScore(500), 100);
  assert.equal(foodImportPressureScore(0, 30), 50);
  assert.equal(foodImportPressureScore(10, 0), 0);
  assert.equal(gdacsEventScore('Red', 0), 100);
  assert.ok(gdacsEventScore('Red', 14) < 40);
  assert.equal(gdacsEventScore('Orange', 0, 'DR'), 24, 'droughts count at 40%');
  assert.equal(creditGapScore(1), 0);
  assert.equal(creditGapScore(10), 70);
  assert.equal(dsrScore(-2), 0);
  assert.equal(nwsSeverityScore(['Minor', 'Severe']), 75);
  assert.equal(nwsSeverityScore([]), 0);
  assert.equal(wastewaterCategoryScore('Very High'), 90);
  assert.equal(wastewaterCategoryScore('n/a'), null);
  assert.equal(kpScore(7.3), 75);
  assert.ok(kpScore(2) < 10);
  assert.equal(femaScore(0, null), 0);
  assert.ok(femaScore(1, 1) > femaScore(1, 120));
});

test('gdeltCountryZ compares the last week to prior weekly means', () => {
  const flat = Array.from({ length: 90 }, () => 1);
  assert.ok(Math.abs(gdeltCountryZ(flat)) < 1e-9);
  const spike = [...Array.from({ length: 83 }, (_, i) => 1 + (i % 3) * 0.1), 3, 3, 3, 3, 3, 3, 3];
  assert.ok(gdeltCountryZ(spike) > 3);
  assert.equal(gdeltCountryZ([1, 2, 3]), null);
});

test('helpers: CSV splitting and country lookups', () => {
  assert.deepEqual(splitCsvLine('"a,b",c,"d ""q"""'), ['a,b', 'c', 'd "q"']);
  assert.equal(iso3FromName('Slovak Republic'), 'SVK');
  assert.equal(iso3FromName('Burma/Myanmar'), 'MMR');
  assert.equal(iso3FromName('United States'), 'USA');
  assert.equal(iso3FromIso2('TW'), 'TWN');
});

test('scoreCountries: renormalizes missing pillars, applies floors, ranks, half-weights GDELT', () => {
  const now = Date.parse('2026-11-04T00:00:00Z');
  const inputs = {
    views: { UKR: { probability: 1, fatalities: 4000 }, USA: { probability: 0, fatalities: 0.2 }, ISL: { probability: 0, fatalities: 0 } },
    ewp: { UKR: { risk: 0.013 }, USA: { risk: 0.0097 }, ISL: { risk: 0.001 } },
    wb: {
      infantMortality: { UKR: { value: 7 }, USA: { value: 5.4 }, ISL: { value: 1.5 } },
      politicalStability: { UKR: { value: -1.9 }, USA: { value: 0 }, ISL: { value: 1.3 } },
      inflation: { UKR: { value: 12, year: '2025' }, USA: { value: 3, year: '2025' } },
      foodImports: {},
    },
    fao: { change3m: 4.5 },
    fews: null,
    gdacs: { events: [] },
    bis: { USA: { creditGap: -11, creditGapPeriod: '2026-Q1', dsrDeviation: -1, dsrPeriod: '2026-Q1' } },
    gdelt: { USA: { z: 3, score: logisticFromZ(3) } },
    ucdp: null,
  };
  const out = scoreCountries(inputs, { now });
  const byIso = Object.fromEntries(out.map((c) => [c.iso3, c]));
  assert.ok(byIso.UKR && byIso.USA && byIso.ISL);
  assert.equal(out[0].iso3, 'UKR', 'sorted hottest first');
  assert.ok(byIso.UKR.t >= 70, 'war floor via ViEWS proxy');
  assert.equal(byIso.UKR.floor.basis, 'ViEWS forecast proxy');
  assert.ok(byIso.ISL.t < byIso.USA.t);
  // ISL has no food or financial data → lower coverage, wider band than if complete.
  assert.ok(byIso.ISL.coverage < 1);
  assert.ok(byIso.ISL.pillars.find((p) => p.id === 'financial').score === null);
  // GDELT fills only half of the mobilisation pillar.
  const mob = byIso.USA.pillars.find((p) => p.id === 'mobilisation');
  assert.equal(mob.effectiveWeight, 20 * MOBILISATION_GDELT_CONFIDENCE);
  // Countries with no data at all are omitted (never shown as zero risk).
  assert.ok(!byIso.FRA);
  for (const c of out) {
    assert.ok(c.t >= 0 && c.t <= 100);
    assert.ok(c.lo <= c.t && c.hi >= c.t);
  }
});

// ── Local route: privacy + graceful degradation (offline) ──
const ENV_KEYS = ['LOCAL_LAT', 'LOCAL_LON', 'LOCAL_PLACE', 'EIA_API_KEY'];
let savedEnv;
let savedFetch;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  ENV_KEYS.forEach((k) => delete process.env[k]);
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  globalThis.fetch = savedFetch;
});

test('local gauge: unconfigured without LOCAL_LAT/LOCAL_LON', async () => {
  const { default: handler } = await import('../api/local/gauge.js');
  const body = await (await handler(new Request('http://localhost/api/local/gauge'))).json();
  assert.equal(body.configured, false);
});

test('local gauge: no coordinates in output, no-store, degrades when sources fail', async () => {
  process.env.LOCAL_LAT = '12.34567';
  process.env.LOCAL_LON = '-56.78901';
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('api.weather.gov/points/')) {
      return ok({ properties: { forecast: null, cwa: 'XXX', county: 'https://api.weather.gov/zones/county/AKC020', relativeLocation: { properties: { city: 'Sampleton', state: 'AK' } } } });
    }
    if (u.includes('api.weather.gov/zones/county/')) return ok({ properties: { name: 'Sample', state: 'AK' } });
    if (u.includes('api.weather.gov/alerts/active')) return ok({ features: [{ properties: { id: 'x', event: 'Wind Advisory', severity: 'Moderate' } }] });
    if (u.includes('services.swpc.noaa.gov')) return ok([{ time_tag: '2026-11-04T00:00:00', Kp: 2.0 }]);
    if (u.includes('fema.gov')) return ok({ DisasterDeclarationsSummaries: [] });
    return new Response('upstream down', { status: 503 });
  };
  const { default: handler } = await import('../api/local/gauge.js');
  const res = await handler(new Request('http://localhost/api/local/gauge'));
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(!text.includes('12.3') && !text.includes('56.7'), 'no coordinates leak');
  assert.equal(body.area.countyFips, '02020');
  assert.equal(body.area.county, 'Sample');
  const hz = body.pillars.find((p) => p.id === 'hazards');
  assert.equal(hz.score, 40);
  const health = body.pillars.find((p) => p.id === 'health');
  assert.equal(health.status, 'unavailable');
  assert.ok(body.coverage < 1, 'failed sources reduce coverage');
  assert.ok(typeof body.t === 'number' && body.band > 0);
  assert.ok(!seen.some((u) => u.includes('api.eia.gov')), 'EIA skipped without a key');
});
