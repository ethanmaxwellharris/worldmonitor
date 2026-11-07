/**
 * GET /api/local/config
 * Public, privacy-safe view of the Local Monitor configuration.
 * Exact LOCAL_LAT / LOCAL_LON never leave the server; only a ~11 km rounded center.
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { getLocalConfig, publicCenter, json } from './_shared.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const cors = getCorsHeaders(request, 'GET, OPTIONS');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (isDisallowedOrigin(request)) return json({ error: 'Origin not allowed' }, { status: 403 });

  const cfg = getLocalConfig();
  if (!cfg) {
    return json({
      configured: false,
      reason: 'Set LOCAL_LAT and LOCAL_LON (server-side env) to enable the Local Monitor.',
    }, { cors });
  }
  return json({
    configured: true,
    center: publicCenter(cfg),
    place: cfg.place || null,
    radiusNm: cfg.radiusNm,
    quakeRadiusKm: cfg.quakeRadiusKm,
    eventsRadiusMi: cfg.eventsRadiusMi,
    features: {
      events: Boolean(process.env.TICKETMASTER_API_KEY),
      news: Boolean(cfg.place || process.env.LOCAL_NEWS_FEEDS),
    },
  }, { cors, maxAge: 300 });
}
