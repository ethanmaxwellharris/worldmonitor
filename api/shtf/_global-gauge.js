/**
 * Orchestrates the global SHTF gauge: fetch every source (each cached and
 * degrading independently), score, attach 30-day trends from daily snapshots,
 * and cache the whole blob. Shared by /api/shtf/gauge and /api/local/gauge.
 */
import { cached } from '../local/_shared.js';
import { getCachedJson, setCachedJson } from '../_upstash-cache.js';
import {
  fetchViews, fetchEwp, fetchWorldBank, fetchFao, fetchFewsNet,
  fetchGdacs, fetchBis, fetchGdeltMobilisation, fetchUcdpFloor,
} from './_global-sources.js';
import { scoreCountries } from './_global-score.js';
import { GLOBAL_PILLARS } from './_scoring.js';

const SOURCE_META = {
  views: { label: 'ViEWS conflict forecasts', url: 'https://viewsforecasting.org/', pillar: 'conflict' },
  ewp: { label: 'Early Warning Project risk', url: 'https://earlywarningproject.ushmm.org/', pillar: 'structural' },
  worldbank: { label: 'World Bank WDI + WGI', url: 'https://data.worldbank.org/', pillar: 'structural, food' },
  fao: { label: 'FAO Food Price Index', url: 'https://www.fao.org/worldfoodsituation/foodpricesindex/en', pillar: 'food' },
  fewsnet: { label: 'FEWS NET IPC Phase 3+ population', url: 'https://fews.net/', pillar: 'food' },
  gdacs: { label: 'GDACS disaster alerts', url: 'https://www.gdacs.org/', pillar: 'hazards' },
  bis: { label: 'BIS credit gap + debt service', url: 'https://data.bis.org/', pillar: 'financial' },
  gdelt: { label: 'GDELT protest coverage (weak, half weight)', url: 'https://www.gdeltproject.org/', pillar: 'mobilisation' },
  ucdp: { label: 'UCDP conflict floor (optional token)', url: 'https://ucdp.uu.se/', pillar: 'floor' },
};

function summarize(id, res) {
  return {
    id,
    ...SOURCE_META[id],
    status: res.status,
    stale: Boolean(res.stale) || undefined,
    asOf: res.asOf || null,
    note: res.note || null,
    error: res.error || undefined,
    count: res.data ? (id === 'gdacs' ? (res.data.events || []).length : id === 'worldbank' || id === 'fao' ? undefined : Object.keys(res.data).length) : 0,
  };
}

const dayKey = (d) => `shtf:snap:v1:${d.toISOString().slice(0, 10)}`;

async function loadPrevious(now) {
  for (const off of [30, 29, 31, 28, 32]) {
    const snap = await getCachedJson(dayKey(new Date(now - off * 86400000))).catch(() => null);
    if (snap && typeof snap === 'object') return { snapshot: snap, daysAgo: off };
  }
  return null;
}

export async function computeGlobalGauge() {
  const { value } = await cached('shtf:gauge:global:v1', 30 * 60, async () => {
    const now = Date.now();
    const views = await fetchViews();
    const [ewp, worldbank, fao, fewsnet, gdacs, bis, gdelt, ucdp] = await Promise.all([
      fetchEwp(views.gw || {}),
      fetchWorldBank(),
      fetchFao(),
      fetchFewsNet(),
      fetchGdacs(),
      fetchBis(),
      fetchGdeltMobilisation(),
      fetchUcdpFloor(),
    ]);
    const previous = await loadPrevious(now);
    const countries = scoreCountries({
      views: views.data,
      ewp: ewp.data,
      wb: worldbank.data || {},
      fao: fao.status === 'live' ? fao.data : null,
      fews: fewsnet.status === 'live' ? fewsnet.data : null,
      gdacs: gdacs.status === 'live' ? gdacs.data : null,
      bis: bis.data,
      gdelt: gdelt.status === 'live' ? gdelt.data : null,
      ucdp: ucdp.status === 'live' ? ucdp.data : null,
    }, { now, previous: previous?.snapshot || null });

    // Persist today's snapshot for future 30-day trends (no-op without Upstash).
    const snap = Object.fromEntries(countries.map((c) => [c.iso3, c.t]));
    await setCachedJson(dayKey(new Date(now)), snap, 40 * 86400).catch(() => false);

    return {
      generatedAt: new Date(now).toISOString(),
      method: {
        pillars: GLOBAL_PILLARS,
        formula: 'T = Σ w·S / Σ w over pillars with data; band = σ(pillars)/√n + 25 × missing weight share',
        levels: { low: '<25', normal: '25–39', elevated: '40–54', high: '55–69', critical: '70+' },
        notes: [
          'Relative risk vs other countries and vs each country’s own past. Not a prediction that anything will happen.',
          'Missing pillars are re-weighted away and widen the band; they are never read as zero risk.',
          'GDELT protest coverage is weak evidence and fills only half of the mobilisation pillar.',
          'Active war floors at 70, minor conflict at 50 (UCDP when a token is set, otherwise a ViEWS forecast proxy).',
          'Not yet backtested in this repo; published model skill: ViEWS/Goldstone AUC ≈ 0.8 with many false alarms.',
        ],
      },
      trendBasis: previous ? `${previous.daysAgo}-day-old snapshot` : 'no snapshot 28–32 days old yet (needs Upstash; trend arrows appear after ~30 days)',
      sources: [
        summarize('views', views), summarize('ewp', ewp), summarize('worldbank', worldbank), summarize('fao', fao),
        summarize('fewsnet', fewsnet), summarize('gdacs', gdacs), summarize('bis', bis), summarize('gdelt', gdelt), summarize('ucdp', ucdp),
      ],
      countries,
    };
  });
  return value;
}
