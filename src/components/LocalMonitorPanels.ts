/**
 * Local Monitor panels (VITE_VARIANT=local).
 * Each panel polls one /api/local/* route on its own cadence; server routes
 * cache upstream calls so multiple tabs don't multiply upstream load.
 */
import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import {
  LOCAL_REFRESH,
  fetchLocalAircraft,
  fetchLocalEvents,
  fetchLocalNews,
  fetchLocalQuakes,
  fetchLocalSatellites,
  fetchLocalWeather,
  type LocalAircraft,
  type LocalConfig,
  type LocalSatellite,
  type LocalWeatherResponse,
} from '@/services/local-monitor';

const NOT_CONFIGURED_HTML = `
  <div class="local-empty">
    <strong>Local Monitor not configured.</strong>
    <p>Set <code>LOCAL_LAT</code> and <code>LOCAL_LON</code> (server-side env, never <code>VITE_*</code>) and redeploy or restart the dev server.</p>
  </div>`;

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '';
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

function link(url: string | null | undefined, text: string): string {
  const safe = sanitizeUrl(url || '');
  return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>` : escapeHtml(text);
}

function footer(text?: string): string {
  return text ? `<div class="local-attrib">${escapeHtml(text)}</div>` : '';
}

/** Base class: interval polling + common empty/error states. */
abstract class LocalPanel extends Panel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(id: string, title: string, private readonly intervalMs: number, infoTooltip?: string) {
    super({ id, title, showCount: true, trackActivity: false, infoTooltip });
  }

  protected abstract load(): Promise<void>;

  public async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.load();
    } catch (error) {
      console.error(`[LocalMonitor] ${this.panelId} failed`, error);
      this.showError();
    } finally {
      this.inFlight = false;
    }
  }

  public start(): void {
    void this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.refresh();
      }, this.intervalMs);
    }
  }

  protected notConfigured(): void {
    this.setCount(0);
    this.setContent(NOT_CONFIGURED_HTML);
  }

  public override destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    super.destroy();
  }
}

// ── Overhead Now: aircraft radar + list ──

function radarSvg(aircraft: LocalAircraft[], radiusNm: number): string {
  const size = 220;
  const c = size / 2;
  const r = c - 12;
  const rings = [1, 2, 3].map((i) => `<circle cx="${c}" cy="${c}" r="${(r * i) / 3}" class="local-radar-ring"/>`).join('');
  const labels = [1, 2, 3].map((i) => `<text x="${c + 3}" y="${c - (r * i) / 3 + 10}" class="local-radar-label">${Math.round((radiusNm * i) / 3)}nm</text>`).join('');
  const blips = aircraft.map((a) => {
    const rad = (a.bearingDeg * Math.PI) / 180;
    const d = Math.min(1, a.distanceNm / radiusNm) * r;
    const x = c + d * Math.sin(rad);
    const y = c - d * Math.cos(rad);
    const rot = a.trackDeg ?? 0;
    const cls = a.emergency ? 'emergency' : a.military ? 'military' : a.onGround ? 'ground' : '';
    const title = escapeHtml(`${a.callsign || a.hex} ${a.type || ''} ${a.altitudeFt ?? '?'}ft ${a.distanceNm}nm ${a.direction}`);
    return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rot})" class="local-radar-blip ${cls}"><title>${title}</title><path d="M0,-6 L4,5 L0,3 L-4,5 Z"/></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" class="local-radar" role="img" aria-label="Aircraft around home">
    ${rings}${labels}
    <line x1="${c}" y1="${c - r}" x2="${c}" y2="${c + r}" class="local-radar-axis"/>
    <line x1="${c - r}" y1="${c}" x2="${c + r}" y2="${c}" class="local-radar-axis"/>
    <text x="${c}" y="9" class="local-radar-cardinal">N</text>
    <circle cx="${c}" cy="${c}" r="3" class="local-radar-home"/>
    ${blips}
  </svg>`;
}

export class LocalOverheadPanel extends LocalPanel {
  constructor() {
    super('local-overhead', 'Overhead Now', LOCAL_REFRESH.aircraft,
      'Aircraft within your configured radius (adsb.lol, OpenSky fallback). Distances are rounded to protect your exact location.');
  }

  protected async load(): Promise<void> {
    const data = await fetchLocalAircraft();
    if (!data.configured) return this.notConfigured();
    const list = data.aircraft || [];
    const airborne = list.filter((a) => !a.onGround);
    this.setCount(airborne.length);
    const radius = data.radiusNm || 25;
    const closest = airborne.slice(0, 12);
    const rows = closest.map((a) => `
      <tr class="${a.emergency ? 'local-row-alert' : ''}">
        <td>${escapeHtml(a.callsign || a.registration || a.hex)}${a.military ? ' <span class="local-tag mil">MIL</span>' : ''}${a.emergency ? ` <span class="local-tag alert">${escapeHtml(a.emergency)}</span>` : ''}</td>
        <td>${escapeHtml(a.type || '—')}</td>
        <td>${a.altitudeFt !== null ? a.altitudeFt.toLocaleString() + ' ft' : '—'}</td>
        <td>${a.distanceNm} nm ${escapeHtml(a.direction)}</td>
        <td>${a.elevationDeg !== null ? a.elevationDeg + '°' : '—'}</td>
      </tr>`).join('');
    const directlyOverhead = airborne.filter((a) => (a.elevationDeg ?? 0) >= 45);
    this.setContent(`
      ${data.error && !list.length ? `<div class="local-error">${escapeHtml(data.error)}</div>` : ''}
      <div class="local-overhead">
        ${radarSvg(airborne, radius)}
        <div class="local-overhead-summary">
          <div class="local-big">${airborne.length}</div><div>aircraft within ${radius} nm</div>
          <div class="local-big">${directlyOverhead.length}</div><div>high overhead (≥45° up)</div>
          ${data.stale ? '<div class="local-tag">stale</div>' : ''}
        </div>
      </div>
      ${rows ? `<table class="local-table"><thead><tr><th>Flight</th><th>Type</th><th>Alt</th><th>Where</th><th>Elev</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="local-empty">No aircraft in range right now.</div>'}
      ${footer(data.attribution)}
    `);
  }
}

// ── Sky Tonight: satellite sky dome + upcoming passes ──

function skyDomeSvg(sats: LocalSatellite[]): string {
  const size = 200;
  const c = size / 2;
  const r = c - 12;
  const rings = [0, 30, 60].map((el) => `<circle cx="${c}" cy="${c}" r="${(r * (90 - el)) / 90}" class="local-radar-ring"/>`).join('');
  const dots = sats.map((s) => {
    const rad = (s.azimuthDeg * Math.PI) / 180;
    const d = (r * (90 - s.elevationDeg)) / 90;
    const x = c + d * Math.sin(rad);
    const y = c - d * Math.cos(rad);
    const cls = s.nakedEyeVisible ? 'visible' : s.sunlit ? 'sunlit' : '';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.name.startsWith('ISS') ? 4 : 2.5}" class="local-sky-sat ${cls}"><title>${escapeHtml(`${s.name} ${s.elevationDeg}° ${s.direction} ${s.altitudeKm} km`)}</title></circle>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" class="local-radar" role="img" aria-label="Satellites above the horizon">
    ${rings}
    <text x="${c}" y="9" class="local-radar-cardinal">N</text>
    <text x="${size - 6}" y="${c + 3}" class="local-radar-cardinal">E</text>
    <text x="${c}" y="${size - 1}" class="local-radar-cardinal">S</text>
    <text x="6" y="${c + 3}" class="local-radar-cardinal">W</text>
    ${dots}
  </svg>`;
}

export class LocalSkyPanel extends LocalPanel {
  constructor() {
    super('local-sky', 'Sky Tonight', LOCAL_REFRESH.satellites,
      'Satellites above your horizon (CelesTrak stations + brightest objects, SGP4 via satellite.js) and upcoming ISS / Tiangong / Hubble passes. "Visible" = sunlit object, dark sky, ≥10° up.');
  }

  protected async load(): Promise<void> {
    const data = await fetchLocalSatellites();
    if (!data.configured) return this.notConfigured();
    const overhead = data.overhead || [];
    this.setCount(overhead.length);
    const visibleNow = overhead.filter((s) => s.nakedEyeVisible);
    const passes = (data.passes || []).map((p) => `
      <li class="${p.nakedEyeVisible ? 'local-pass-visible' : ''}">
        <strong>${escapeHtml(p.name)}</strong> ${escapeHtml(clock(p.rise))}
        · max ${p.maxElevationDeg}° · ${escapeHtml(p.riseDirection)} → ${escapeHtml(p.setDirection)} · ${p.durationMin} min
        ${p.nakedEyeVisible ? '<span class="local-tag ok">naked-eye</span>' : ''}
      </li>`).join('');
    const top = overhead.slice(0, 6).map((s) => `<li>${escapeHtml(s.name)} — ${s.elevationDeg}° ${escapeHtml(s.direction)}, ${s.altitudeKm} km${s.nakedEyeVisible ? ' <span class="local-tag ok">visible</span>' : ''}</li>`).join('');
    this.setContent(`
      ${data.error ? `<div class="local-error">${escapeHtml(data.error)}</div>` : ''}
      <div class="local-overhead">
        ${skyDomeSvg(overhead)}
        <div class="local-overhead-summary">
          <div class="local-big">${overhead.length}</div><div>tracked objects above horizon (of ${data.tracked ?? '?'})</div>
          <div class="local-big">${visibleNow.length}</div><div>naked-eye visible now</div>
          <div>Sun ${data.sunElevationDeg ?? '?'}° · ${data.darkSky ? 'dark sky' : 'daylight/twilight'}</div>
        </div>
      </div>
      ${top ? `<div class="local-subhead">Highest now</div><ul class="local-list">${top}</ul>` : ''}
      <div class="local-subhead">Next passes (24 h)</div>
      ${passes ? `<ul class="local-list">${passes}</ul>` : '<div class="local-empty">No passes ≥10° in the next 24 h.</div>'}
      ${footer(data.attribution)}
    `);
  }
}

// ── Weather & Alerts (NWS) ──

export class LocalWeatherPanel extends LocalPanel {
  private onData?: (data: LocalWeatherResponse) => void;

  constructor(onData?: (data: LocalWeatherResponse) => void) {
    super('local-weather', 'Weather & Alerts', LOCAL_REFRESH.weather, 'Active NWS alerts and forecast for your point (US only).');
    this.onData = onData;
  }

  protected async load(): Promise<void> {
    const data = await fetchLocalWeather();
    this.onData?.(data);
    if (!data.configured) return this.notConfigured();
    if (data.supported === false) {
      this.setCount(0);
      this.setContent('<div class="local-empty">NWS covers US locations only.</div>');
      return;
    }
    const alerts = data.alerts || [];
    this.setCount(alerts.length);
    const sev = (s: string) => (s || '').toLowerCase();
    const alertHtml = alerts.map((a) => `
      <div class="local-alert sev-${escapeHtml(sev(a.severity))}">
        <div class="local-alert-title">${escapeHtml(a.event)} <span class="local-tag">${escapeHtml(a.severity)}</span></div>
        <div class="local-alert-head">${escapeHtml(a.headline || '')}</div>
        ${a.expires ? `<div class="local-dim">Until ${escapeHtml(clock(a.expires))}</div>` : ''}
      </div>`).join('');
    const forecast = (data.forecast || []).slice(0, 6).map((p) => `
      <div class="local-fc">
        <div class="local-fc-name">${escapeHtml(p.name)}</div>
        <div class="local-fc-temp">${p.temperature}°${escapeHtml(p.temperatureUnit)}</div>
        <div class="local-fc-desc">${escapeHtml(p.shortForecast)}</div>
        <div class="local-dim">${p.precipitationChance !== null ? `${p.precipitationChance}% precip · ` : ''}${escapeHtml(p.wind)}</div>
      </div>`).join('');
    const loc = data.location;
    this.setContent(`
      ${loc ? `<div class="local-dim">${escapeHtml([loc.city, loc.state].filter(Boolean).join(', '))}${loc.county ? ` · ${escapeHtml(loc.county)} County` : ''}${loc.office ? ` · NWS ${escapeHtml(loc.office)}` : ''}</div>` : ''}
      ${alertHtml || '<div class="local-ok">No active NWS alerts for your point.</div>'}
      <div class="local-fc-grid">${forecast}</div>
      ${footer(data.attribution)}
    `);
  }
}

// ── Quakes Nearby (USGS) ──

export class LocalQuakesPanel extends LocalPanel {
  constructor() {
    super('local-quakes', 'Quakes Nearby', LOCAL_REFRESH.quakes, 'USGS earthquakes M1+ in the past 30 days within your configured radius.');
  }

  protected async load(): Promise<void> {
    const data = await fetchLocalQuakes();
    if (!data.configured) return this.notConfigured();
    const quakes = data.quakes || [];
    this.setCount(quakes.length);
    const rows = quakes.slice(0, 25).map((q) => `
      <tr>
        <td class="local-mag mag-${Math.min(7, Math.floor(q.magnitude || 0))}">M${(q.magnitude ?? 0).toFixed(1)}</td>
        <td>${link(q.url, q.place || 'Unknown')}</td>
        <td>${q.distanceKm} km ${escapeHtml(q.direction)}</td>
        <td>${escapeHtml(timeAgo(q.time))}</td>
      </tr>`).join('');
    this.setContent(`
      ${data.error ? `<div class="local-error">${escapeHtml(data.error)}</div>` : ''}
      ${rows ? `<table class="local-table"><tbody>${rows}</tbody></table>` : `<div class="local-ok">No M1+ quakes within ${data.radiusKm ?? '?'} km in 30 days.</div>`}
      ${footer(data.attribution)}
    `);
  }
}

// ── Local News (Google News RSS + optional outlet feeds) ──

export class LocalNewsPanel extends LocalPanel {
  constructor() {
    super('local-news', 'Local News', LOCAL_REFRESH.news, 'Google News search for LOCAL_PLACE plus any LOCAL_NEWS_FEEDS outlet RSS feeds.');
  }

  protected async load(): Promise<void> {
    const data = await fetchLocalNews();
    if (!data.configured) return this.notConfigured();
    if (data.enabled === false) {
      this.setCount(0);
      this.setContent(`<div class="local-empty">${escapeHtml(data.reason || 'Local news not configured.')}</div>`);
      return;
    }
    const items = data.items || [];
    this.setCount(items.length);
    const list = items.slice(0, 30).map((n) => `
      <li>${link(n.link, n.title)}<div class="local-dim">${escapeHtml(n.source || n.feed)} · ${escapeHtml(timeAgo(n.publishedAt))}</div></li>`).join('');
    this.setContent(`
      ${data.error ? `<div class="local-error">${escapeHtml(data.error)}</div>` : ''}
      ${list ? `<ul class="local-list local-news">${list}</ul>` : '<div class="local-empty">No local headlines in the last 2 days.</div>'}
    `);
  }
}

// ── Local Events (Ticketmaster, optional key) ──

export class LocalEventsPanel extends LocalPanel {
  constructor() {
    super('local-events', 'Local Events', LOCAL_REFRESH.events, 'Upcoming events near you from the Ticketmaster Discovery API (needs TICKETMASTER_API_KEY).');
  }

  protected async load(): Promise<void> {
    const data = await fetchLocalEvents();
    if (!data.configured) return this.notConfigured();
    if (data.enabled === false) {
      this.setCount(0);
      this.setContent(`<div class="local-empty">Add a free <code>TICKETMASTER_API_KEY</code> (server-side env) to see upcoming events near you.</div>`);
      return;
    }
    const events = data.events || [];
    this.setCount(events.length);
    const list = events.slice(0, 25).map((e) => `
      <li>${link(e.url, e.name)}
        <div class="local-dim">${escapeHtml([e.date, e.time?.slice(0, 5)].filter(Boolean).join(' '))} · ${escapeHtml(e.venue || '')}${e.distanceMi !== null ? ` · ${e.distanceMi} mi` : ''}${e.genre ? ` · ${escapeHtml(e.genre)}` : ''}</div></li>`).join('');
    this.setContent(`
      ${data.error ? `<div class="local-error">${escapeHtml(data.error)}</div>` : ''}
      ${list ? `<ul class="local-list">${list}</ul>` : '<div class="local-empty">No upcoming events found.</div>'}
      ${footer(data.attribution)}
    `);
  }
}

// ── Scanners & live link-outs (no scraping; links only) ──

export class LocalScannersPanel extends Panel {
  private cfg: LocalConfig | null = null;
  private weather: LocalWeatherResponse | null = null;

  constructor() {
    super({
      id: 'local-scanners',
      title: 'Scanners & Live Links',
      trackActivity: false,
      infoTooltip: 'Link-outs only. Broadcastify and OpenMHz do not offer open APIs for embedding, so streams open on their sites. Links use your rounded (~11 km) center.',
    });
  }

  public setConfig(cfg: LocalConfig): void { this.cfg = cfg; this.render(); }
  public setWeather(w: LocalWeatherResponse): void { this.weather = w; this.render(); }

  private render(): void {
    if (!this.cfg) return;
    if (!this.cfg.configured || !this.cfg.center) {
      this.setContent(NOT_CONFIGURED_HTML);
      return;
    }
    const { lat, lon } = this.cfg.center;
    const loc = this.weather?.location;
    const countyQ = loc?.county && loc?.state ? `${loc.county} County ${loc.state}` : (this.cfg.place || '');
    const radar = loc?.radarStation ? `https://radar.weather.gov/station/${encodeURIComponent(loc.radarStation)}/standard` : 'https://radar.weather.gov/';
    const groups: Array<[string, Array<[string, string]>]> = [
      ['Police / fire / EMS scanners', [
        ['Broadcastify — browse feeds', 'https://www.broadcastify.com/listen/'],
        ['OpenMHz — trunked systems', 'https://openmhz.com/systems'],
        ['RadioReference — frequency DB', `https://www.radioreference.com/db/browse/`],
        ...(countyQ ? [[`Search "${countyQ}" scanners`, `https://www.google.com/search?q=${encodeURIComponent(`${countyQ} police scanner broadcastify`)}`] as [string, string]] : []),
      ]],
      ['Sky', [
        ['adsb.lol live map', `https://adsb.lol/?lat=${lat}&lon=${lon}&zoom=10`],
        ['ADS-B Exchange', `https://globe.adsbexchange.com/?lat=${lat}&lon=${lon}&zoom=10`],
        ['Heavens-Above passes', `https://www.heavens-above.com/?lat=${lat}&lng=${lon}`],
      ]],
      ['Weather', [
        ['NWS radar', radar],
        ['NWS point forecast', `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`],
        ['Windy', `https://www.windy.com/?${lat},${lon},9`],
      ]],
    ];
    this.setContent(groups.map(([title, links]) => `
      <div class="local-subhead">${escapeHtml(title)}</div>
      <ul class="local-list">${links.map(([text, url]) => `<li>${link(url, text)}</li>`).join('')}</ul>`).join(''));
  }
}

// The SHTF gauge lives in ./ShtfGaugePanel.ts (global + local modes).
export { ShtfGaugePanel } from './ShtfGaugePanel';
