/**
 * Pure country scoring for the global SHTF gauge (no I/O; unit-tested).
 * inputs: the `data` payloads returned by api/shtf/_global-sources.js.
 */
import { COUNTRIES, countryName, iso2FromIso3 } from './_countries.js';
import {
  GLOBAL_PILLARS,
  viewsScore,
  percentileRanks,
  averageAvailable,
  combinePillars,
  applyFloor,
  floorFromViews,
  levelFor,
  ipcShareScore,
  inflationScore,
  foodImportPressureScore,
  gdacsEventScore,
  creditGapScore,
  dsrScore,
  trendFor,
  round1,
} from './_scoring.js';

/** GDELT-derived mobilisation is weak evidence: it fills only half the pillar's weight. */
export const MOBILISATION_GDELT_CONFIDENCE = 0.5;

const r1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? round1(n) : null);

export function scoreCountries(inputs, { now = Date.now(), previous = null } = {}) {
  const { views = {}, ewp = {}, wb = {}, fao = null, fews = null, gdacs = null, bis = {}, gdelt = null, ucdp = null } = inputs;

  // Slow structural values → global percentile ranks.
  const ewpPct = percentileRanks(Object.fromEntries(Object.entries(ewp).map(([k, v]) => [k, v.risk])));
  const imrPct = percentileRanks(Object.fromEntries(Object.entries(wb.infantMortality || {}).map(([k, v]) => [k, v.value])));
  const pvPct = percentileRanks(
    Object.fromEntries(Object.entries(wb.politicalStability || {}).map(([k, v]) => [k, v.value])),
    { higherIsWorse: false },
  );

  // Hazards: GDACS max per country (GDACS is global: no alert = 0, not missing).
  const hazard = {};
  const hazardDrivers = {};
  if (gdacs && Array.isArray(gdacs.events)) {
    for (const e of gdacs.events) {
      const age = e.toDate ? (now - Date.parse(e.toDate)) / 86400000 : 0;
      const s = gdacsEventScore(e.alertLevel, age, e.type);
      for (const iso3 of e.iso3 || []) {
        if (s > (hazard[iso3] ?? -1)) { hazard[iso3] = s; hazardDrivers[iso3] = `${e.alertLevel} ${e.name}`; }
      }
    }
  }

  const out = [];
  for (const [iso3] of COUNTRIES) {
    const v = views[iso3];
    const comps = {};

    // Conflict forecast (30)
    const conflict = v ? viewsScore(v.probability, v.fatalities) : null;
    comps.conflict = v ? [{ id: 'views', label: 'ViEWS P(25+ deaths) & predicted fatalities, months 1–3', value: `${Math.round((v.probability ?? 0) * 100)}% · ${r1(v.fatalities)} /mo`, score: r1(conflict) }] : [];

    // Structural fragility (20)
    const sComps = [
      ['ewp', 'EWP mass-killing risk (percentile)', ewp[iso3]?.risk, ewpPct[iso3]],
      ['imr', 'Infant mortality (percentile)', wb.infantMortality?.[iso3]?.value, imrPct[iso3]],
      ['wgi', 'WGI political stability (inverted percentile)', wb.politicalStability?.[iso3]?.value, pvPct[iso3]],
    ].filter((c) => typeof c[3] === 'number');
    const structural = averageAvailable(sComps.map((c) => c[3]));
    comps.structural = sComps.map(([id, label, value, score]) => ({ id, label, value: r1(id === 'ewp' ? value * 100 : value), score: r1(score) }));

    // Mobilisation anomaly (20) — GDELT at half confidence
    const g = gdelt?.[iso3];
    const mobilisation = g ? g.score : null;
    comps.mobilisation = g ? [{ id: 'gdelt', label: 'Protest/riot coverage, 7 days vs own 12-week baseline (z)', value: r1(g.z), score: r1(g.score) }] : [];

    // Food & cost of living (15)
    const fComps = [];
    const f = fews?.[iso3];
    if (f) fComps.push({ id: 'ipc', label: 'FEWS NET population in IPC Phase 3+ (%)', value: r1(f.pct), score: r1(ipcShareScore(f.pct)) });
    const infl = wb.inflation?.[iso3];
    if (infl) fComps.push({ id: 'cpi', label: `CPI inflation ${infl.year} (%)`, value: r1(infl.value), score: r1(inflationScore(infl.value)) });
    const imp = wb.foodImports?.[iso3];
    if (fao && imp) {
      const s = foodImportPressureScore(fao.change3m, imp.value);
      if (s !== null) fComps.push({ id: 'ffpi', label: `FAO FFPI 3-mo change ${r1(fao.change3m)}% × food import share`, value: r1(imp.value), score: r1(s) });
    }
    const food = averageAvailable(fComps.map((c) => c.score));
    comps.food = fComps;

    // Disasters & infrastructure (10)
    const hz = gdacs ? (hazard[iso3] ?? 0) : null;
    comps.hazards = gdacs ? [{ id: 'gdacs', label: 'GDACS orange/red alerts, 30 days (decayed)', value: hazardDrivers[iso3] || 'none', score: r1(hz) }] : [];

    // Financial fragility (5)
    const b = bis[iso3];
    const bComps = [];
    if (b && typeof b.creditGap === 'number') bComps.push({ id: 'creditGap', label: `BIS credit-to-GDP gap ${b.creditGapPeriod} (pp)`, value: r1(b.creditGap), score: r1(creditGapScore(b.creditGap)) });
    if (b && typeof b.dsrDeviation === 'number') bComps.push({ id: 'dsr', label: `Debt service ratio vs own mean ${b.dsrPeriod} (pp)`, value: r1(b.dsrDeviation), score: r1(dsrScore(b.dsrDeviation)) });
    const financial = averageAvailable(bComps.map((c) => c.score));
    comps.financial = bComps;

    const scores = { conflict, structural, mobilisation, food, hazards: hz, financial };
    const pillarInputs = [];
    for (const p of GLOBAL_PILLARS) {
      if (p.id === 'mobilisation' && scores.mobilisation !== null) {
        const eff = p.weight * MOBILISATION_GDELT_CONFIDENCE;
        pillarInputs.push({ id: p.id, weight: eff, score: scores.mobilisation });
        pillarInputs.push({ id: 'mobilisation-unfilled', weight: p.weight - eff, score: null });
      } else {
        pillarInputs.push({ id: p.id, weight: p.weight, score: scores[p.id] });
      }
    }
    const combined = combinePillars(pillarInputs);
    if (combined.temperature === null) continue; // too little data to say anything

    const intensity = ucdp?.[iso3] ?? (v ? floorFromViews(v.fatalities, v.probability) : null);
    const floored = applyFloor(combined.temperature, intensity);
    const t = floored.temperature;
    const prev = previous?.[iso3];
    const trend = trendFor(t, prev, combined.band);

    const pillars = GLOBAL_PILLARS.map((p) => ({
      id: p.id,
      label: p.label,
      weight: p.weight,
      score: r1(scores[p.id]),
      effectiveWeight: p.id === 'mobilisation' && scores.mobilisation !== null ? p.weight * MOBILISATION_GDELT_CONFIDENCE : scores[p.id] === null ? 0 : p.weight,
      components: comps[p.id],
    }));
    const drivers = pillars
      .filter((p) => p.score !== null && p.effectiveWeight > 0)
      .map((p) => ({ id: p.id, label: p.label, contribution: (p.effectiveWeight * p.score) }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
      .map((d) => d.label);

    out.push({
      iso3,
      iso2: iso2FromIso3(iso3),
      name: countryName(iso3),
      t: r1(t),
      band: r1(combined.band),
      lo: r1(Math.max(0, t - combined.band)),
      hi: r1(Math.min(100, t + combined.band)),
      level: levelFor(t),
      coverage: combined.coverage,
      floor: floored.floor ? { value: floored.floor, basis: ucdp?.[iso3] ? 'UCDP' : 'ViEWS forecast proxy', intensity } : null,
      trend: trend.trend,
      delta30d: trend.delta,
      drivers,
      pillars,
    });
  }
  out.sort((a, b) => b.t - a.t);
  return out;
}
