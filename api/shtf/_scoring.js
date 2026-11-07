/**
 * SHTF gauge scoring — pure functions, no I/O (unit-tested in tests/shtf-scoring.test.mjs).
 *
 * Design source: "SHTF Gauge: Research + Heat Map Design" Page.
 * The gauge is a RELATIVE-RISK index (0–100), not a prediction. Every score
 * ships with an uncertainty band, per-pillar coverage and as-of dates.
 *
 *   s/100 = 1 / (1 + e^(−1.5(z − 1.5)))           fast flows (z vs own baseline)
 *   T     = Σ w_p·S_p / Σ w_p (pillars with data)  renormalized over available pillars
 *   band  = ± (σ_pillars/√n + 25 · missing weight share)
 *
 * σ_pillars/√n is the standard error of the weighted pillar mean: raw pillar
 * dispersion (σ) mostly measures how different the pillars are, not how
 * unsure we are about T, and made almost every band > 20.
 */

/** Global pillar weights (sum 100). Weighted by out-of-sample evidence first, lead time second. */
export const GLOBAL_PILLARS = [
  { id: 'conflict', label: 'Conflict forecast', weight: 30 },
  { id: 'structural', label: 'Structural fragility', weight: 20 },
  { id: 'mobilisation', label: 'Protest / violence spike vs own baseline', weight: 20 },
  { id: 'food', label: 'Food & cost of living', weight: 15 },
  { id: 'hazards', label: 'Disasters & infrastructure', weight: 10 },
  { id: 'financial', label: 'Financial fragility', weight: 5 },
];

/** Local (US county) pillar weights (sum 100). */
export const LOCAL_PILLARS = [
  { id: 'hazards', label: 'Hazards now (NWS alerts)', weight: 30 },
  { id: 'infrastructure', label: 'Grid & infrastructure', weight: 20 },
  { id: 'health', label: 'Health (wastewater)', weight: 15 },
  { id: 'economy', label: 'Prices & jobs', weight: 15 },
  { id: 'unrest', label: 'Unrest vs own baseline', weight: 10 },
  { id: 'declarations', label: 'FEMA disaster declarations', weight: 5 },
  { id: 'spaceWeather', label: 'Space weather', weight: 5 },
];

export const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
export const round1 = (n) => Math.round(n * 10) / 10;

/** Logistic squash of a z-score: z=1.5 → 50, z=3 → ~90, z=0 → ~10. */
export function logisticFromZ(z) {
  if (!isNum(z)) return null;
  return 100 / (1 + Math.exp(-1.5 * (z - 1.5)));
}

/** Mean / sample standard deviation. */
export function meanStd(values) {
  const v = values.filter(isNum);
  if (v.length === 0) return { mean: null, std: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (v.length < 2) return { mean, std: 0, n: v.length };
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1);
  return { mean, std: Math.sqrt(variance), n: v.length };
}

/**
 * z-score of `current` vs a baseline sample. Returns null when the baseline
 * is too short (< minN) to be meaningful. A floor on σ (minStd, or 10% of the
 * mean) keeps near-constant baselines from exploding tiny changes.
 */
export function zScore(current, baseline, { minN = 4, minStd = 0 } = {}) {
  if (!isNum(current)) return null;
  const { mean, std, n } = meanStd(baseline);
  if (n < minN || mean === null) return null;
  const sigma = Math.max(std, minStd, Math.abs(mean) * 0.1, 1e-9);
  return (current - mean) / sigma;
}

/** ViEWS: 50% P(25+ battle deaths) + 50% ln(1+fatalities)/ln(1001), capped at 100. */
export function viewsScore(probability, fatalities) {
  const hasP = isNum(probability);
  const hasF = isNum(fatalities);
  if (!hasP && !hasF) return null;
  const p = hasP ? clamp(probability, 0, 1) : null;
  const f = hasF ? clamp(Math.log1p(Math.max(0, fatalities)) / Math.log(1001), 0, 1) : null;
  if (p === null) return clamp(f * 100);
  if (f === null) return clamp(p * 100);
  return clamp(50 * p + 50 * f);
}

/**
 * Percentile rank (0–100) for every key of a {key: value} map.
 * `higherIsWorse=false` inverts (e.g. political-stability estimates).
 * Ties share the average rank.
 */
export function percentileRanks(valuesByKey, { higherIsWorse = true } = {}) {
  const entries = Object.entries(valuesByKey).filter(([, v]) => isNum(v));
  const out = {};
  const n = entries.length;
  if (n === 0) return out;
  if (n === 1) { out[entries[0][0]] = 50; return out; }
  entries.sort((a, b) => a[1] - b[1]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && entries[j + 1][1] === entries[i][1]) j++;
    const avgRank = (i + j) / 2; // 0-based
    const pct = (avgRank / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out[entries[k][0]] = higherIsWorse ? pct : 100 - pct;
    i = j + 1;
  }
  return out;
}

/** Average of the available component scores (null when none). */
export function averageAvailable(values) {
  const v = values.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** CII-compatible levels so the two maps agree. */
export function levelFor(score) {
  if (!isNum(score)) return 'unknown';
  if (score >= 70) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 40) return 'elevated';
  if (score >= 25) return 'normal';
  return 'low';
}

/**
 * Combine pillar scores into a temperature.
 * pillars: [{ id, weight, score|null }]
 * Missing pillars are dropped and the remaining weights renormalized — never
 * treated as zero risk. The band widens with σ across pillars and with the
 * share of weight that is missing.
 */
export function combinePillars(pillars, { minCoverage = 0.3 } = {}) {
  const total = pillars.reduce((a, p) => a + p.weight, 0);
  const present = pillars.filter((p) => isNum(p.score));
  const presentWeight = present.reduce((a, p) => a + p.weight, 0);
  const coverage = total > 0 ? presentWeight / total : 0;
  if (present.length === 0 || coverage < minCoverage) {
    return { temperature: null, band: null, coverage: round1(coverage * 100) / 100, missingWeightShare: 1 - coverage, sigma: null };
  }
  const temperature = present.reduce((a, p) => a + p.weight * p.score, 0) / presentWeight;
  // Weighted σ of pillar scores around T.
  const variance = present.reduce((a, p) => a + p.weight * (p.score - temperature) ** 2, 0) / presentWeight;
  const sigma = Math.sqrt(variance);
  const missingWeightShare = 1 - coverage;
  const band = sigma / Math.sqrt(present.length) + 25 * missingWeightShare;
  return {
    temperature: clamp(temperature),
    band: clamp(band, 0, 50),
    coverage: Math.round(coverage * 100) / 100,
    missingWeightShare: Math.round(missingWeightShare * 100) / 100,
    sigma,
  };
}

/**
 * Conflict floor (mirrors country-instability getUcdpFloor): an active war
 * never reads below 70, a minor conflict never below 50.
 * intensity: 'war' | 'minor' | null.
 */
export function applyFloor(temperature, intensity) {
  if (!isNum(temperature)) return { temperature, floor: null };
  const floor = intensity === 'war' ? 70 : intensity === 'minor' ? 50 : 0;
  return { temperature: Math.max(temperature, floor), floor: floor || null };
}

/**
 * Floor intensity proxy from ViEWS forecasts when UCDP history is unavailable:
 * predicted ≥1,000 battle deaths/yr → war; ≥25/yr with P(25+) ≥ 0.5 → minor.
 */
export function floorFromViews(monthlyFatalities, probability) {
  if (!isNum(monthlyFatalities)) return null;
  const annual = monthlyFatalities * 12;
  if (annual >= 1000) return 'war';
  if (annual >= 25 && isNum(probability) && probability >= 0.5) return 'minor';
  return null;
}

/** Trend: only report warming/cooling when the 30-day change exceeds the band. */
export function trendFor(current, previous, band) {
  if (!isNum(current) || !isNum(previous)) return { trend: null, delta: null };
  const delta = current - previous;
  const threshold = isNum(band) ? band : 10;
  if (Math.abs(delta) <= threshold) return { trend: 'steady', delta: round1(delta) };
  return { trend: delta > 0 ? 'warming' : 'cooling', delta: round1(delta) };
}

// ── Indicator → 0–100 mappings ──

/** FEWS NET share of population in IPC Phase 3+ (percent) → 0–100. 5%≈28, 15%≈63, 30%≈86. */
export function ipcShareScore(pct) {
  if (!isNum(pct)) return null;
  return clamp(100 * (1 - Math.exp(-Math.max(0, pct) / 15)));
}

/** Annual consumer-price inflation (%) → 0–100, log-scaled: ≤2%→0, 3%≈10, 10%≈41, 30%≈69, 100%+→100. */
export function inflationScore(pct) {
  if (!isNum(pct)) return null;
  if (pct <= 2) return 0;
  return clamp((100 * Math.log10(pct / 2)) / Math.log10(50));
}

/**
 * Global food-price pressure scaled by food-import dependence.
 * ffpiChange3m: 3-month % change of FAO FFPI; importShare: food % of merchandise imports.
 */
export function foodImportPressureScore(ffpiChange3m, importShare) {
  if (!isNum(ffpiChange3m) || !isNum(importShare)) return null;
  const pressure = clamp(50 + ffpiChange3m * 5, 0, 100); // +10% in 3 months → 100, flat → 50
  const exposure = clamp(importShare / 30, 0, 1);        // 30%+ of imports are food → fully exposed
  return clamp(pressure * exposure);
}

/**
 * GDACS alert → hazard score with exponential decay by age (half-life ~10 days).
 * Droughts are slow-onset, continental-scale alerts: they count at 40%.
 */
export function gdacsEventScore(alertLevel, ageDays, eventType = '') {
  const base = alertLevel === 'Red' ? 100 : alertLevel === 'Orange' ? 60 : alertLevel === 'Green' ? 10 : 0;
  const typeFactor = eventType === 'DR' ? 0.4 : 1;
  const age = isNum(ageDays) ? Math.max(0, ageDays) : 0;
  return clamp(base * typeFactor * Math.exp(-age / 14));
}

/** BIS credit-to-GDP gap (pp) → 0–100. Basel CCyB guide: 2pp starts, 10pp is the warning level. */
export function creditGapScore(gap) {
  if (!isNum(gap)) return null;
  if (gap <= 2) return 0;
  if (gap <= 10) return ((gap - 2) / 8) * 70;
  return clamp(70 + (gap - 10) * 3);
}

/** BIS debt-service ratio deviation from own long-run mean (pp) → 0–100. Drehmann & Juselius: >6pp is critical. */
export function dsrScore(deviation) {
  if (!isNum(deviation)) return null;
  if (deviation <= 0) return 0;
  return clamp((deviation / 6) * 80);
}

/** NWS alert severity → 0–100 (max across active alerts). */
export function nwsSeverityScore(severities) {
  const map = { Extreme: 100, Severe: 75, Moderate: 40, Minor: 15 };
  let best = 0;
  for (const s of severities || []) best = Math.max(best, map[s] ?? 0);
  return best;
}

/** CDC NWSS wastewater viral activity category → 0–100. */
export function wastewaterCategoryScore(category) {
  const map = { 'very low': 5, low: 20, moderate: 45, high: 70, 'very high': 90 };
  return map[String(category || '').trim().toLowerCase()] ?? null;
}

/** NOAA planetary Kp → 0–100 (G1=Kp5→40, G3=Kp7→75, G5=Kp9→100). */
export function kpScore(kp) {
  if (!isNum(kp)) return null;
  if (kp < 4) return clamp(kp * 2.5);
  if (kp < 5) return 20;
  const table = { 5: 40, 6: 55, 7: 75, 8: 90, 9: 100 };
  return table[Math.min(9, Math.floor(kp))];
}

/** Open FEMA declarations for the county → 0–100 (lagging confirmation). */
export function femaScore(openDeclarations, mostRecentDaysAgo) {
  if (!isNum(openDeclarations)) return null;
  if (openDeclarations <= 0) return 0;
  const recency = isNum(mostRecentDaysAgo) ? Math.exp(-Math.max(0, mostRecentDaysAgo) / 60) : 0.5;
  return clamp(40 + 60 * recency);
}
