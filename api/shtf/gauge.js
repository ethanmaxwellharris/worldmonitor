/**
 * GET /api/shtf/gauge
 * Global SHTF "temperature" per country (0–100, with uncertainty band, pillar
 * breakdown, coverage and source status). Public data only — no user
 * location involved — so a short shared CDN cache is fine.
 *
 * Optional query: ?iso3=USA returns one country (plus sources/method).
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { computeGlobalGauge } from './_global-gauge.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const cors = getCorsHeaders(request, 'GET, OPTIONS');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors });
  if (isDisallowedOrigin(request)) return Response.json({ error: 'Origin not allowed' }, { status: 403 });

  try {
    const gauge = await computeGlobalGauge();
    const iso3 = new URL(request.url).searchParams.get('iso3')?.toUpperCase();
    const body = iso3 ? { ...gauge, countries: gauge.countries.filter((c) => c.iso3 === iso3) } : gauge;
    return new Response(JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
        ...cors,
      },
    });
  } catch (error) {
    return Response.json({ error: 'SHTF gauge unavailable', detail: String(error?.message || error) }, { status: 502, headers: { ...cors, 'Cache-Control': 'no-store' } });
  }
}
