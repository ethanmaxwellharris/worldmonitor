/**
 * Local Monitor API route tests (offline: upstream fetch is mocked).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = ['LOCAL_LAT', 'LOCAL_LON', 'LOCAL_PLACE', 'LOCAL_RADIUS_NM', 'TICKETMASTER_API_KEY', 'LOCAL_NEWS_FEEDS', 'LOCAL_NEWS_QUERY'];
let savedEnv;
let savedFetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  ENV_KEYS.forEach((k) => delete process.env[k]);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  globalThis.fetch = savedFetch;
});

const req = (path) => new Request(`http://localhost${path}`, { headers: { origin: 'http://localhost:5173' } });

test('config reports unconfigured without LOCAL_LAT/LOCAL_LON', async () => {
  const { default: handler } = await import('../api/local/config.js');
  const body = await (await handler(req('/api/local/config'))).json();
  assert.equal(body.configured, false);
});

test('config returns only a rounded center, never exact coords', async () => {
  process.env.LOCAL_LAT = '12.34567';
  process.env.LOCAL_LON = '-56.78901';
  const { default: handler } = await import('../api/local/config.js');
  const res = await handler(req('/api/local/config'));
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.configured, true);
  assert.deepEqual(body.center, { lat: 12.3, lon: -56.8 });
  assert.ok(!text.includes('12.34567') && !text.includes('56.78901'));
  assert.ok(!/public/.test(res.headers.get('cache-control') || ''), 'must not be CDN-cacheable');
});

test('disallowed origins are rejected', async () => {
  process.env.LOCAL_LAT = '40.7'; process.env.LOCAL_LON = '-74';
  const { default: handler } = await import('../api/local/aircraft.js');
  const res = await handler(new Request('http://localhost/api/local/aircraft', { headers: { origin: 'https://evil.example' } }));
  assert.equal(res.status, 403);
});

test('aircraft shapes adsb.lol data, filters by radius and rounds distance', async () => {
  process.env.LOCAL_LAT = '10.5'; process.env.LOCAL_LON = '20.5'; process.env.LOCAL_RADIUS_NM = '10';
  let calledUrl = '';
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ ac: [
      { hex: 'abc123', flight: 'TEST1  ', t: 'A320', alt_baro: 12000, gs: 300, track: 90, lat: 10.55, lon: 20.55 },
      { hex: 'far001', flight: 'FAR', alt_baro: 30000, lat: 12.0, lon: 22.0 },
      { hex: 'gnd001', flight: 'GND', alt_baro: 'ground', lat: 10.501, lon: 20.501 },
    ] }), { status: 200 });
  };
  const { default: handler } = await import('../api/local/aircraft.js');
  const body = await (await handler(req('/api/local/aircraft'))).json();
  assert.match(calledUrl, /^https:\/\/api\.adsb\.lol\/v2\/point\/10\.5000\/20\.5000\/10$/);
  assert.equal(body.source, 'adsb.lol');
  assert.equal(body.count, 2);
  const a = body.aircraft.find((x) => x.hex === 'abc123');
  assert.equal(a.callsign, 'TEST1');
  assert.equal(a.distanceNm % 0.5, 0);
  assert.equal(a.direction, 'NE');
  assert.equal(body.aircraft.find((x) => x.hex === 'gnd001').onGround, true);
});

test('events degrade gracefully without TICKETMASTER_API_KEY', async () => {
  process.env.LOCAL_LAT = '40.7'; process.env.LOCAL_LON = '-74';
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  const { default: handler } = await import('../api/local/events.js');
  const res = await handler(req('/api/local/events'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, false);
  assert.deepEqual(body.events, []);
});

test('news is disabled without LOCAL_PLACE or feeds', async () => {
  process.env.LOCAL_LAT = '40.7'; process.env.LOCAL_LON = '-74';
  const { default: handler } = await import('../api/local/news.js');
  const body = await (await handler(req('/api/local/news'))).json();
  assert.equal(body.enabled, false);
});

test('parseFeed handles RSS items with CDATA and entities', async () => {
  const { parseFeed } = await import('../api/local/_shared.js');
  const xml = `<rss><channel>
    <item><title><![CDATA[Road closed &amp; detour]]></title><link>https://example.com/a</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><source url="x">Local Paper</source></item>
    <item><title>No link</title></item>
  </channel></rss>`;
  const items = parseFeed(xml, 'fallback');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Road closed & detour');
  assert.equal(items[0].source, 'Local Paper');
  assert.equal(items[0].publishedAt, '2026-11-03T10:00:00.000Z');
});
