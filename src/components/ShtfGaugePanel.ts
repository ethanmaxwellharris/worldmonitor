/**
 * SHTF Gauge panel — evidence-weighted relative-risk "temperature" (0–100).
 *
 *  - Global mode (all variants that enable it): selected country gauge with
 *    uncertainty band, per-pillar breakdown, hottest-countries list, source
 *    status and caveats.
 *  - Local mode (VITE_VARIANT=local): home-county gauge beside the US
 *    national gauge (shown side by side, never summed), plus the global list.
 *
 * Copy is deliberately calm: plain level words, no sirens or countdowns.
 * This is relative risk, not a prediction.
 */
import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import {
  fetchShtfGlobal,
  fetchShtfLocal,
  shtfColor,
  SHTF_LEVEL_LABEL,
  type ShtfCountry,
  type ShtfGlobalGauge,
  type ShtfLocalGauge,
  type ShtfPillar,
} from '@/services/shtf';

const REFRESH_MS = 15 * 60 * 1000;

const CAVEATS = [
  'Shows relative risk compared with other places and with each place’s own past. It is not a prediction that anything will happen.',
  'Expect many more warm readings than real crises: rare events guarantee false alarms, even for good models (published AUCs ≈ 0.8).',
  'Missing data is re-weighted away and widens the band; it is never read as “safe”.',
  'Data lags differ: forecasts are monthly, structure is annual, alerts are live. Each pillar shows its as-of date where known.',
  'News-derived signals over-report places with heavy media coverage; GDELT counts at half weight.',
];

function fmt(n: number | null | undefined, digits = 0): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/** Semicircle gauge: level-coloured track, band arc, needle. */
export function gaugeSvg(t: number | null | undefined, lo?: number | null, hi?: number | null, size = 150): string {
  const w = size;
  const h = size * 0.64;
  const cx = w / 2;
  const cy = size * 0.5;
  const r = w * 0.42;
  const pt = (v: number, rr = r) => {
    const a = Math.PI * (1 - Math.max(0, Math.min(100, v)) / 100);
    return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)] as const;
  };
  const arc = (a: number, b: number, rr = r) => {
    const [x0, y0] = pt(a, rr);
    const [x1, y1] = pt(b, rr);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${rr} ${rr} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const segs: Array<[number, number]> = [[0, 25], [25, 40], [40, 55], [55, 70], [70, 100]];
  const track = segs.map(([a, b]) => `<path d="${arc(a, b)}" stroke="${shtfColor((a + b) / 2)}" stroke-width="${w * 0.07}" fill="none" opacity="0.55"/>`).join('');
  const hasT = typeof t === 'number' && Number.isFinite(t);
  const band = hasT && typeof lo === 'number' && typeof hi === 'number' && hi > lo
    ? `<path d="${arc(lo, hi, r - w * 0.075)}" stroke="var(--text-dim)" stroke-width="${w * 0.03}" fill="none" stroke-linecap="round" opacity="0.8"><title>Uncertainty band ${fmt(lo)}–${fmt(hi)}</title></path>`
    : '';
  const needle = hasT
    ? (() => { const [x, y] = pt(t as number, r * 0.98); return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--text)" stroke-width="2.5" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="4" fill="var(--text)"/>`; })()
    : '';
  return `<svg class="shtf-gauge-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Gauge ${hasT ? fmt(t) : 'no data'} of 100">${track}${band}${needle}
    <text x="${(pt(0)[0] - 3).toFixed(1)}" y="${(cy + 12).toFixed(1)}" class="shtf-gauge-tick">0</text><text x="${(pt(100)[0] - 9).toFixed(1)}" y="${(cy + 12).toFixed(1)}" class="shtf-gauge-tick">100</text></svg>`;
}

function pillarRows(pillars: ShtfPillar[]): string {
  return pillars.map((p) => {
    const has = typeof p.score === 'number';
    const pct = has ? Math.max(2, Math.min(100, p.score as number)) : 0;
    const half = has && p.effectiveWeight > 0 && p.effectiveWeight < p.weight;
    const comps = p.components.length
      ? `<ul class="shtf-comp-list">${p.components.map((c) => `<li><span>${escapeHtml(c.label)}</span><span class="shtf-comp-val">${escapeHtml(String(c.value ?? '—'))}${typeof c.score === 'number' ? ` → <b>${fmt(c.score)}</b>` : ''}</span></li>`).join('')}</ul>`
      : '';
    const notes = p.notes?.length ? `<div class="local-dim">${p.notes.map((n) => escapeHtml(n)).join('<br>')}</div>` : '';
    const meta = [p.asOf ? `as of ${escapeHtml(p.asOf.slice(0, 10))}` : '', p.source ? escapeHtml(p.source) : '', p.scope ? `${escapeHtml(p.scope)} level` : ''].filter(Boolean).join(' · ');
    return `<details class="shtf-pillar${has ? '' : ' shtf-missing'}">
      <summary>
        <span class="shtf-pillar-label">${escapeHtml(p.label)} <span class="local-dim">${p.weight}%${half ? ' (½ weight: weak evidence)' : ''}</span></span>
        <span class="shtf-bar"><span style="width:${pct}%;background:${has ? shtfColor(p.score as number) : 'transparent'}"></span></span>
        <span class="shtf-pillar-score">${has ? fmt(p.score) : 'no data'}</span>
      </summary>
      ${comps}${meta ? `<div class="local-dim">${meta}</div>` : ''}${notes}
    </details>`;
  }).join('');
}

function headline(name: string, t: number | null | undefined, band: number | null | undefined, level: string | undefined, coverage: number | undefined, extra = ''): string {
  const lvl = (level || 'unknown') as keyof typeof SHTF_LEVEL_LABEL;
  return `<div class="shtf-headline">
    <div class="shtf-place">${escapeHtml(name)}</div>
    <div class="shtf-temp" style="color:${typeof t === 'number' ? shtfColor(t) : 'var(--text-dim)'}">${fmt(t)}<span class="shtf-band">± ${fmt(band)}</span></div>
    <div class="shtf-level">${SHTF_LEVEL_LABEL[lvl] ?? 'No data'} · coverage ${typeof coverage === 'number' ? Math.round(coverage * 100) : '—'}%${extra}</div>
  </div>`;
}

function trendText(c: ShtfCountry): string {
  if (c.trend === 'warming') return ` · warming (+${fmt(c.delta30d)} in 30 d)`;
  if (c.trend === 'cooling') return ` · cooling (${fmt(c.delta30d)} in 30 d)`;
  if (c.trend === 'steady') return ' · steady vs 30 d ago';
  return '';
}

export class ShtfGaugePanel extends Panel {
  private global: ShtfGlobalGauge | null = null;
  private local: ShtfLocalGauge | null = null;
  private selected: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onShowHeatmap: (() => void) | null = null;
  private onCountrySelect: ((c: ShtfCountry) => void) | null = null;

  constructor(private readonly mode: 'global' | 'local' = 'global') {
    super({
      id: 'shtf-gauge',
      title: mode === 'local' ? 'SHTF Gauge · Home county' : 'SHTF Gauge · World',
      trackActivity: false,
      infoTooltip: 'Evidence-weighted relative-risk temperature (0–100) with an uncertainty band. Weights follow published out-of-sample skill: conflict forecasts 30, structural fragility 20, protest/violence spikes 20, food &amp; cost of living 15, disasters 10, financial fragility 5. Not a prediction.',
    });
    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>('[data-shtf-iso3]');
      if (row?.dataset.shtfIso3) { this.select(row.dataset.shtfIso3, true); return; }
      if (target.closest('[data-shtf-heatmap]')) this.onShowHeatmap?.();
    });
    this.content.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      if (sel.matches('select[data-shtf-select]') && sel.value) this.select(sel.value, true);
    });
  }

  public setOnShowHeatmap(cb: () => void): void { this.onShowHeatmap = cb; }
  public setOnCountrySelect(cb: (c: ShtfCountry) => void): void { this.onCountrySelect = cb; }

  public start(): void {
    this.showLoading('Computing temperatures…');
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
  }

  /** Select by ISO3 or ISO2 (map country clicks give ISO2). */
  public select(code: string, fromUser = false): void {
    const c = this.global?.countries.find((x) => x.iso3 === code || x.iso2 === code);
    if (!c) return;
    this.selected = c.iso3;
    this.render();
    if (fromUser) this.onCountrySelect?.(c);
  }

  public getGlobal(): ShtfGlobalGauge | null { return this.global; }

  public async refresh(): Promise<void> {
    const [g, l] = await Promise.allSettled([
      fetchShtfGlobal(),
      this.mode === 'local' ? fetchShtfLocal() : Promise.resolve(null),
    ]);
    if (g.status === 'fulfilled') this.global = g.value;
    if (l.status === 'fulfilled') this.local = l.value;
    if (!this.global && !this.local) {
      this.showError('SHTF gauge data unavailable right now.');
      this.setDataBadge('unavailable');
      return;
    }
    const total = this.global?.sources.length ?? 0;
    const live = this.global?.sources.filter((s) => s.status === 'live').length ?? 0;
    this.setDataBadge(live > 0 ? 'live' : 'unavailable', total ? `${live}/${total} sources` : undefined);
    if (!this.selected && this.global) this.selected = this.global.countries.some((c) => c.iso3 === 'USA') ? 'USA' : this.global.countries[0]?.iso3 ?? null;
    this.render();
  }

  private renderLocal(): string {
    const l = this.local;
    if (!l) return '';
    if (!l.configured) return `<div class="local-empty"><strong>Home location not configured.</strong><p>Set <code>LOCAL_LAT</code>/<code>LOCAL_LON</code> server-side to enable the county gauge.</p></div>`;
    if (l.supported === false) return `<div class="local-empty">${escapeHtml(l.reason || 'Not supported for this location.')}</div>`;
    if (l.error) return `<div class="local-empty">County gauge unavailable: ${escapeHtml(l.error)}</div>`;
    const us = this.global?.countries.find((c) => c.iso3 === 'USA');
    const place = [l.area?.county, l.area?.state].filter(Boolean).join(', ') || 'Home county';
    return `
      <div class="shtf-duo">
        <div class="shtf-card">
          ${gaugeSvg(l.t, l.lo, l.hi)}
          ${headline(place, l.t, l.band, l.level, l.coverage)}
        </div>
        <div class="shtf-card shtf-card-secondary">
          ${gaugeSvg(us?.t, us?.lo, us?.hi, 120)}
          ${headline('United States (national)', us?.t, us?.band, us?.level, us?.coverage)}
        </div>
      </div>
      <div class="local-dim shtf-note">County and national temperatures use different indicators and are shown side by side, never added together.</div>
      ${l.drivers?.length ? `<div class="shtf-drivers">Main drivers: ${l.drivers.map((d) => escapeHtml(d)).join(' · ')}</div>` : ''}
      <div class="local-subhead">County breakdown</div>
      ${pillarRows(l.pillars || [])}`;
  }

  private renderGlobal(): string {
    const g = this.global;
    if (!g) return '<div class="local-dim">World temperatures unavailable.</div>';
    const c = g.countries.find((x) => x.iso3 === this.selected) || g.countries[0];
    const top = g.countries.slice(0, 10);
    const options = g.countries.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((x) => `<option value="${x.iso3}"${x.iso3 === c?.iso3 ? ' selected' : ''}>${escapeHtml(x.name)} — ${fmt(x.t)}</option>`).join('');
    const selectedBlock = c ? `
      <div class="shtf-card shtf-card-wide">
        ${gaugeSvg(c.t, c.lo, c.hi)}
        ${headline(c.name, c.t, c.band, c.level, c.coverage, trendText(c))}
      </div>
      ${c.floor ? `<div class="local-dim shtf-note">Floor applied: active ${escapeHtml(c.floor.intensity)} conflict keeps this at ≥ ${c.floor.value} (${escapeHtml(c.floor.basis)}).</div>` : ''}
      ${c.drivers.length ? `<div class="shtf-drivers">Main drivers: ${c.drivers.map((d) => escapeHtml(d)).join(' · ')}</div>` : ''}
      ${pillarRows(c.pillars)}` : '';
    return `
      <div class="shtf-toolbar">
        <select data-shtf-select aria-label="Choose country">${options}</select>
        <button class="shtf-btn" data-shtf-heatmap title="Turn on the SHTF heat-map layer">Show heat map</button>
      </div>
      ${selectedBlock}
      <div class="local-subhead">Warmest now (relative)</div>
      <ol class="shtf-top">${top.map((x) => `
        <li data-shtf-iso3="${x.iso3}" class="${x.iso3 === c?.iso3 ? 'active' : ''}">
          <span class="shtf-swatch" style="background:${shtfColor(x.t)}"></span>
          <span class="shtf-top-name">${escapeHtml(x.name)}</span>
          <span class="shtf-top-t">${fmt(x.t)} <span class="local-dim">±${fmt(x.band)}</span></span>
        </li>`).join('')}</ol>`;
  }

  private renderSources(): string {
    const g = this.global;
    const rows = (g?.sources || []).map((s) => {
      const url = sanitizeUrl(s.url);
      const name = url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a>` : escapeHtml(s.label);
      return `<li><span class="shtf-dot ${s.status === 'live' ? 'ok' : 'off'}"></span>${name} <span class="local-dim">${escapeHtml(s.pillar)}${s.asOf ? ` · ${escapeHtml(String(s.asOf).slice(0, 10))}` : ''}${s.status !== 'live' && s.error ? ` · ${escapeHtml(s.error)}` : ''}</span></li>`;
    }).join('');
    return `
      <details class="shtf-sources">
        <summary>Sources, method &amp; caveats</summary>
        <ul class="shtf-source-list">${rows}</ul>
        <div class="local-dim">${escapeHtml(g?.method.formula || '')}. Levels: under 25 low, 25–39 normal, 40–54 elevated, 55–69 high, 70+ critical. Trend: ${escapeHtml(g?.trendBasis || 'n/a')}.</div>
        <ul class="shtf-caveats">${CAVEATS.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
      </details>
      <div class="local-attrib">Relative risk, not a prediction. Updated ${g ? escapeHtml(new Date(g.generatedAt).toLocaleString()) : '—'}.</div>`;
  }

  private render(): void {
    const body = this.mode === 'local'
      ? `${this.renderLocal()}<details class="shtf-world"><summary>World temperatures</summary>${this.renderGlobal()}</details>`
      : this.renderGlobal();
    this.setContent(`<div class="shtf-panel">${body}${this.renderSources()}</div>`);
  }

  public destroy(): void {
    if (this.timer) clearInterval(this.timer);
    super.destroy();
  }
}
