/**
 * Local Monitor client service: thin typed wrappers around /api/local/*.
 * The browser never sees exact home coordinates; the server only returns
 * a rounded center (~11 km) via /api/local/config.
 */

export interface LocalConfig {
  configured: boolean;
  reason?: string;
  center?: { lat: number; lon: number };
  place?: string | null;
  radiusNm?: number;
  quakeRadiusKm?: number;
  eventsRadiusMi?: number;
  features?: { events: boolean; news: boolean };
}

export interface LocalAircraft {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  altitudeFt: number | null;
  onGround: boolean;
  speedKt: number | null;
  trackDeg: number | null;
  verticalRateFpm: number | null;
  squawk: string | null;
  emergency: string | null;
  military: boolean;
  lat: number;
  lon: number;
  distanceNm: number;
  bearingDeg: number;
  direction: string;
  elevationDeg: number | null;
  source: string;
}

export interface LocalAircraftResponse {
  configured: boolean;
  reason?: string;
  radiusNm?: number;
  count?: number;
  source?: string;
  aircraft: LocalAircraft[];
  attribution?: string;
  stale?: boolean;
  error?: string;
}

export interface LocalSatellite {
  name: string;
  norad: number;
  azimuthDeg: number;
  direction: string;
  elevationDeg: number;
  rangeKm: number;
  altitudeKm: number;
  sunlit: boolean;
  nakedEyeVisible: boolean;
}

export interface LocalPass {
  name: string;
  norad: number;
  rise: string;
  riseDirection: string;
  maxAt: string;
  maxElevationDeg: number;
  set: string;
  setDirection: string;
  durationMin: number;
  nakedEyeVisible: boolean;
}

export interface LocalSatellitesResponse {
  configured: boolean;
  reason?: string;
  tracked?: number;
  sunElevationDeg?: number;
  darkSky?: boolean;
  overhead: LocalSatellite[];
  passes: LocalPass[];
  attribution?: string;
  error?: string;
}

export interface LocalAlert {
  id: string;
  event: string;
  severity: string;
  urgency: string;
  certainty: string;
  headline: string;
  areaDesc: string;
  effective: string;
  expires: string;
  senderName: string;
  instruction: string | null;
  url: string | null;
}

export interface LocalForecastPeriod {
  name: string;
  startTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  precipitationChance: number | null;
  wind: string;
  shortForecast: string;
  icon: string;
}

export interface LocalWeatherResponse {
  configured: boolean;
  reason?: string;
  supported?: boolean;
  location?: { city: string | null; state: string | null; county: string | null; office: string | null; timeZone: string | null; radarStation?: string | null };
  alerts: LocalAlert[];
  forecast: LocalForecastPeriod[];
  attribution?: string;
  error?: string;
}

export interface LocalQuake {
  id: string;
  magnitude: number;
  place: string;
  time: string | null;
  depthKm: number | null;
  lat: number;
  lon: number;
  distanceKm: number;
  direction: string;
  felt: number | null;
  tsunami: boolean;
  alert: string | null;
  url: string;
}

export interface LocalQuakesResponse {
  configured: boolean;
  reason?: string;
  radiusKm?: number;
  quakes: LocalQuake[];
  attribution?: string;
  error?: string;
}

export interface LocalNewsItem {
  title: string;
  link: string;
  source: string;
  feed: string;
  publishedAt: string | null;
}

export interface LocalNewsResponse {
  configured: boolean;
  reason?: string;
  enabled?: boolean;
  place?: string | null;
  items: LocalNewsItem[];
  error?: string;
}

export interface LocalEvent {
  id: string;
  name: string;
  url: string;
  date: string | null;
  time: string | null;
  dateTime: string | null;
  status: string | null;
  segment: string | null;
  genre: string | null;
  venue: string | null;
  city: string | null;
  distanceMi: number | null;
}

export interface LocalEventsResponse {
  configured: boolean;
  reason?: string;
  enabled?: boolean;
  radiusMi?: number;
  events: LocalEvent[];
  attribution?: string;
  error?: string;
}

async function getJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (body && typeof body === 'object') return { ...fallback, ...body } as T;
    return { ...fallback, error: `HTTP ${res.status}` } as T;
  } catch (error) {
    return { ...fallback, error: String((error as Error)?.message || error) } as T;
  }
}

export const fetchLocalConfig = () => getJson<LocalConfig>('/api/local/config', { configured: false });
export const fetchLocalAircraft = () => getJson<LocalAircraftResponse>('/api/local/aircraft', { configured: false, aircraft: [] });
export const fetchLocalSatellites = () => getJson<LocalSatellitesResponse>('/api/local/satellites', { configured: false, overhead: [], passes: [] });
export const fetchLocalWeather = () => getJson<LocalWeatherResponse>('/api/local/weather', { configured: false, alerts: [], forecast: [] });
export const fetchLocalQuakes = () => getJson<LocalQuakesResponse>('/api/local/quakes', { configured: false, quakes: [] });
export const fetchLocalNews = () => getJson<LocalNewsResponse>('/api/local/news', { configured: false, items: [] });
export const fetchLocalEvents = () => getJson<LocalEventsResponse>('/api/local/events', { configured: false, events: [] });

/** Refresh cadences (ms). Server-side caches keep upstream load lower still. */
export const LOCAL_REFRESH = {
  aircraft: 15_000,
  satellites: 60_000,
  weather: 5 * 60_000,
  quakes: 5 * 60_000,
  news: 10 * 60_000,
  events: 60 * 60_000,
} as const;
