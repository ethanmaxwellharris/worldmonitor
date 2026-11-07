# Local Monitor variant

A hyper-local "DLC" for World Monitor: what is happening around one home point.

```bash
# .env.local (server-side; never VITE_*)
LOCAL_LAT=                 # your latitude
LOCAL_LON=                 # your longitude
LOCAL_PLACE="Your City, ST"

npm run dev:local      # dev server; /api/local/* served by a Vite dev middleware
npm run build:local    # production build
npm run test:local     # offline route tests
```

## Panels and sources

| Panel | Route | Source | Key | Cache |
| --- | --- | --- | --- | --- |
| Overhead Now (radar + list) | `/api/local/aircraft` | adsb.lol `/v2/point` (ODbL), OpenSky anonymous bbox fallback | none | 10 s |
| Sky Tonight (sky dome + passes) | `/api/local/satellites` | CelesTrak GP `stations` + `visual`, SGP4 via `satellite.js` | none | TLE 2 h, result 30 s |
| Weather & Alerts | `/api/local/weather` | NWS `api.weather.gov` points / forecast / alerts (US only) | none (User-Agent) | points 24 h, forecast 30 min, alerts 2 min |
| Quakes Nearby | `/api/local/quakes` | USGS FDSN event query, M1+, 30 days | none | 5 min |
| Local News | `/api/local/news` | Google News RSS search for `LOCAL_PLACE` + `LOCAL_NEWS_FEEDS` | none | 10 min |
| Local Events | `/api/local/events` | Ticketmaster Discovery (`latlong` + radius) | `TICKETMASTER_API_KEY` | 1 h |
| Scanners & Live Links | (client) | link-outs: Broadcastify, OpenMHz, RadioReference, adsb.lol, ADS-B Exchange, Heavens-Above, NWS radar, Windy | none | — |
| SHTF Gauge (county + national) | `/api/local/gauge`, `/api/shtf/gauge` | NWS alerts, FAA NAS status, CDC NWSS wastewater, DOL weekly claims, OpenFEMA, NOAA SWPC Kp, GDELT (half weight); EIA grid/gas optional | `EIA_API_KEY` optional | 5–60 min per source |

The map recenters on the rounded home center and keeps the existing
`natural` (USGS/EONET) and `weather` (NWS) layers.

Caching is two-tier: per-isolate memory plus Upstash Redis when
`UPSTASH_REDIS_REST_URL/TOKEN` are set. Responses are `private`/`no-store`
so a CDN never caches location-derived data.

## Privacy

- `LOCAL_LAT` / `LOCAL_LON` are read only on the server.
- `/api/local/config` returns a center rounded to 0.1° (~11 km).
- Aircraft distances are rounded to 0.5 nm and bearings to 5°.
- Nearby aircraft, quakes and forecasts still reveal the general area. Deploy
  the local variant as its own Vercel project with Vercel Authentication
  (or another access gate) on production before setting real coordinates.

## SHTF gauge

A 0–100 relative-risk temperature with an uncertainty band. It is not a
prediction. The weights follow published out-of-sample skill.

**Global (`/api/shtf/gauge`, optional `?iso3=`)**, one score per country:

| Pillar | Weight | Sources |
|---|---|---|
| Conflict forecast | 30 | ViEWS fatalities model, months 1–3 |
| Structural fragility | 20 | Early Warning Project, World Bank infant mortality, WGI political stability (percentile ranks) |
| Protest/violence spike vs own baseline | 20 | GDELT source-country volume z-score (half weight, weak signal) |
| Food & cost of living | 15 | FEWS NET IPC 3+, World Bank CPI, FAO FFPI × food import share |
| Disasters & infrastructure | 10 | GDACS Orange/Red, last 30 days |
| Financial fragility | 5 | BIS credit gap, debt service ratio |

How the score is built:

- Fast signals are logistic-squashed z-scores against each place's own baseline.
- T = Σw·S / Σw over the pillars that have data.
- Band = σ(pillars)/√n + 25 × the missing weight share. Coverage is shown, and
  countries under 30% coverage are omitted.
- Active war keeps a country at ≥ 70 and minor conflict at ≥ 50. This uses UCDP
  when `UCDP_ACCESS_TOKEN` is set, and a ViEWS-forecast proxy otherwise.
- The 30-day trend needs Upstash, which keeps daily snapshots for 40 days.

The global result is public and CDN-cacheable. The map layer `shtf` is a country
choropleth: hatched where the band is wider than ±20, fading out below country
scale.

**Local (`/api/local/gauge`)**: the US county comes from NWS points →
county zone → FIPS. The weights are hazards 30, grid & infrastructure 20,
wastewater health 15, prices & jobs 15, unrest 10, FEMA declarations 5 and
space weather 5. The response carries no coordinates, cache keys use FIPS/state,
and it is sent `no-store`. The county and national temperatures are shown side
by side and never added together.

Optional env: `EIA_API_KEY` (free; grid demand and gasoline),
`UCDP_ACCESS_TOKEN` (conflict floors) and `SHTF_EWP_CSV_URL` (override the Early
Warning Project CSV). Every source degrades to "no data", which widens the band.
