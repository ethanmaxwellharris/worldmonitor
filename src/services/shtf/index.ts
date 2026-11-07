import type { ShtfGlobalGauge, ShtfLocalGauge, ShtfLevel } from './types';

export type {
  ShtfCountry, ShtfComponent, ShtfGlobalGauge, ShtfLocalGauge, ShtfLevel, ShtfPillar, ShtfSourceStatus,
} from './types';

let globalCache: { at: number; data: ShtfGlobalGauge } | null = null;
let globalInflight: Promise<ShtfGlobalGauge> | null = null;
const GLOBAL_TTL_MS = 10 * 60 * 1000;

/** Global per-country gauge (shared by the map layer and the panel; deduped). */
export function fetchShtfGlobal(force = false): Promise<ShtfGlobalGauge> {
  if (!force && globalCache && Date.now() - globalCache.at < GLOBAL_TTL_MS) return Promise.resolve(globalCache.data);
  if (globalInflight) return globalInflight;
  globalInflight = (async () => {
    try {
      const res = await fetch('/api/shtf/gauge');
      if (!res.ok) throw new Error(`SHTF gauge HTTP ${res.status}`);
      const data = (await res.json()) as ShtfGlobalGauge;
      globalCache = { at: Date.now(), data };
      return data;
    } finally {
      globalInflight = null;
    }
  })();
  return globalInflight;
}

/** Home-county gauge (local variant). Coordinates never leave the server. */
export async function fetchShtfLocal(): Promise<ShtfLocalGauge> {
  const res = await fetch('/api/local/gauge');
  if (!res.ok && res.status !== 502) throw new Error(`Local gauge HTTP ${res.status}`);
  return (await res.json()) as ShtfLocalGauge;
}

/** Sequential temperature ramp (cool → warm). Deliberately no flashing/alarm reds. */
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [49, 130, 189]],
  [25, [116, 173, 209]],
  [40, [254, 224, 144]],
  [55, [253, 174, 97]],
  [70, [244, 109, 67]],
  [100, [165, 0, 38]],
];

export function shtfColorRgb(t: number): [number, number, number] {
  const v = Math.max(0, Math.min(100, t));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i]!;
    const [t0, c0] = STOPS[i - 1]!;
    if (v <= t1) {
      const f = (v - t0) / (t1 - t0 || 1);
      return [0, 1, 2].map((k) => Math.round(c0[k]! + (c1[k]! - c0[k]!) * f)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1]![1];
}

export function shtfColor(t: number): string {
  const [r, g, b] = shtfColorRgb(t);
  return `rgb(${r}, ${g}, ${b})`;
}

export const SHTF_LEVEL_LABEL: Record<ShtfLevel, string> = {
  low: 'Low', normal: 'Normal', elevated: 'Elevated', high: 'High', critical: 'Critical', unknown: 'No data',
};

/** Bands wider than this are hatched on the map. */
export const SHTF_WIDE_BAND = 20;
