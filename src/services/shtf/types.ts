/**
 * SHTF gauge — client types. Server: api/shtf/gauge.js (global, per country)
 * and api/local/gauge.js (home county, US). Scores are 0–100 RELATIVE risk
 * with an uncertainty band; they are not predictions.
 */

export type ShtfLevel = 'low' | 'normal' | 'elevated' | 'high' | 'critical' | 'unknown';

export interface ShtfComponent {
  id: string;
  label: string;
  value: string | number | null;
  score: number | null;
}

export interface ShtfPillar {
  id: string;
  label: string;
  weight: number;
  effectiveWeight: number;
  score: number | null;
  components: ShtfComponent[];
  status?: 'live' | 'unavailable';
  asOf?: string | null;
  source?: string | null;
  scope?: string | null;
  notes?: string[];
}

export interface ShtfCountry {
  iso3: string;
  iso2: string | null;
  name: string;
  t: number;
  band: number;
  lo: number;
  hi: number;
  level: ShtfLevel;
  coverage: number;
  floor: { value: number; basis: string; intensity: string } | null;
  trend: 'warming' | 'cooling' | 'steady' | null;
  delta30d: number | null;
  drivers: string[];
  pillars: ShtfPillar[];
}

export interface ShtfSourceStatus {
  id: string;
  label: string;
  url: string;
  pillar: string;
  status: 'live' | 'unavailable';
  stale?: boolean;
  asOf: string | null;
  note: string | null;
  error?: string;
  count?: number;
}

export interface ShtfGlobalGauge {
  generatedAt: string;
  method: { pillars: { id: string; label: string; weight: number }[]; formula: string; levels: Record<string, string>; notes: string[] };
  trendBasis: string;
  sources: ShtfSourceStatus[];
  countries: ShtfCountry[];
}

export interface ShtfLocalGauge {
  configured: boolean;
  supported?: boolean;
  reason?: string;
  error?: string;
  area?: { county: string | null; state: string; stateName: string; countyFips: string | null };
  t?: number | null;
  band?: number | null;
  lo?: number | null;
  hi?: number | null;
  level?: ShtfLevel;
  coverage?: number;
  drivers?: string[];
  pillars?: ShtfPillar[];
  method?: { formula: string; notes: string[] };
  generatedAt?: string;
}
