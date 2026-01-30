// Roblox Experience Stats scraper (Cheerio + optional Playwright)
// Tries API-first (recommended), falls back to HTML scraping. Saves structured items to Dataset and raw JSON to KV.

import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset, KeyValueStore } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://www.roblox.com/games/1818/Adventure-Forward'],
  experienceIds = [],
  useApi = true,
  useBrowser = false,
  maxRequestsPerCrawl = 500,
  followInternalOnly = true,
  checkPlaceDetails = true,
  concurrency = 10,
} = input;

const dataset = await Dataset.open();
const kv = await KeyValueStore.open();
const proxyConfiguration = await Actor.createProxyConfiguration();

// Helpers
function resolveUrl(base, href) {
  try { return new URL(href, base).toString(); } catch (e) { return null; }
}

// Attempt to extract a numeric placeId or experienceId from a Roblox URL
function extractIdsFromUrl(url) {
  try {
    const u = new URL(url);
    // Patterns: /games/<placeId>/<name> or /games/<experienceId>/<name>
    const m = u.pathname.match(/\/games\/(\d+)/);
    if (m) return { placeId: m[1] };
    // some pages use ?id= or /places/<id>
    const q = u.searchParams.get('id') || null;
    if (q && /^\d+$/.test(q)) return { placeId: q };
    const m2 = u.pathname.match(/\/places\/(\d+)/);
    if (m2) return { placeId: m2[1] };
  } catch (e) {
    // ignore
  }
  return {};
}

// Roblox public endpoint attempts (best-effort).
// NOTE: Roblox may change endpoints; adjust if needed.
async function fetchRobloxGameApiByPlaceId(placeId) {
  // Try place details endpoint
  try {
    const url = `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${encodeURIComponent(placeId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (Array.isArray(json) && json.length) return json[0];
    if (json && json[placeId]) return json[placeId];
    return json;
  } catch (e) {
    return null;
  }
}

// Alternative / universe lookup if you have universeId; try common games endpoint
async function fetchRobloxGameApiByUniverseId(universeId) {
  try {
    const url = `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (json && json.data && json.data.length) return json.data[0];
    return json;
  } catch (e) {
    return null;
  }
}

// Heuristic: parse embedded JSON from page scripts (Roblox often embeds bootstrapData or initial state)
function parseEmbeddedJson($) {
  const scripts = $('script').map((i, el) => $(el).html()).get() || [];
  for (const s of scripts) {
    if (!s) continue;
    // look for "game" or "experience" JSON snippets
    const m = s.match(/(Roblox\.PlaceLauncherService|window\.__INITIAL_STATE__|bootstrapData|Roblox\.(?:GameLaunch|Place))\s*[:=]\s*(\{[\s\S]{20,}\})/i);
    if (m && m[2]) {
      try {
        const j = JSON.parse(m[2]);
        return j;
      } catch (e) {
        // fallback: attempt loose JSON extraction
        try {
          const objText = m[2].replace(/;$/, '');
          return JSON.parse(objText);
        } catch (err) {
          // continue
        }
      }
    }
    // attempt application/ld+json
    if (s.trim().startsWith('{') && s.includes('"@type"')) {
      try {
        const j = JSON.parse(s);
        return j;
      } catch (e) {}
    }
  }
  return null;
}

// Normalize api/page data into a consistent record
function normalizeRecord({ apiData = null, pageData = null, url = '', placeId = null }) {
  const r = {
    experience_id: apiData?.universeId || pageData?.experienceId || null,
    place_id: placeId || apiData?.rootPlaceId || apiData?.placeId || pageData?.placeId || null,
    name: apiData?.name || pageData?.name || '',
    creator: (apiData && apiData.creator && (apiData.creator.name || apiData.creator.creatorType)) || pageData?.creator || '',
    visits: apiData?.visits || pageData?.visits || null,
    favorites: apiData?.favoritedCount || pageData?.favorites || null,
    playing: apiData?.playing || pageData?.playing || null,
    maxPlayers: apiData?.maxPlayers || pageData?.maxPlayers || null,
    price: apiData?.price || pageData?.price || null,
    genre: apiData?.genre || pageData?.genre || '',
    url,
    raw_api: apiData || null,
    raw_page: pageData || null,
    extracted_at: new Date().toISOString()
  };
  return r;
}

// Cheerio handler: extract page-level fields and optionally call API
async function cheerioHandler({ request, $, log, enqueueLinks }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Processing (cheerio)', { url });

  // Enqueue more relevant links (games pages)
  await enqueueLinks({
    globs: ['**/games/**', '**/places/**'],
    transformRequestFunction: (r) => {
      if (followInternalOnly) {
        try {
          const startHost = request.userData.startHost || new URL(request.url).host;
          if (new URL(r.url).host !== startHost) return null;
        } catch (e) { return null; }
      }
      return r;
    }
  });

  const ids = extractIdsFromUrl(url);
  const placeId = ids.placeId || null;

  // Try parse embedded JSON for dynamic fields
  const pageJson = parseEmbeddedJson($);

  // Try to collect some obvious selectors as fallback
  const name = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
  // visits/favorites/playing often appear as numeric text near badges; heuristic:
  const visitsText = $('span.stat-value, .count, .text-lead, .text-robux, .stats .value').filter((i, el) => $(el).text().trim().match(/\d/)).first().text().trim();
  const visits = visitsText ? visitsText.replace(/[^0-9]/g, '') : null;

  // If API mode is enabled, try API calls
  let apiData = null;
  if (useApi && placeId) {
    apiData = await fetchRobloxGameApiByPlaceId(placeId);
  }

  // optionally try extra placeDetails/universe lookup
  if (!apiData && useApi && pageJson && pageJson.universeId && checkPlaceDetails) {
    apiData = await fetchRobloxGameApiByUniverseId(pageJson.universeId);
  }

  const record = normalizeRecord({
    apiData,
    pageData: { name: name || pageJson?.name || '', visits: apiData ? apiData.visits : visits, ...pageJson },
    url,
    placeId
  });

  await dataset.pushData(record);

  // Save raw data to KV keyed by place or URL
  try {
    const key = placeId ? `experiences/${placeId}` : `experiences/${encodeURIComponent(url)}`;
    await kv.setValue(key, { url, apiData, pageJson }, { contentType: 'application/json' });
  } catch (e) {
    log.warning('Failed to save raw JSON to KV', { url, error: e.message });
  }
}

// Playwright handler: render page and capture dynamic player counts & meta
async function playwrightHandler({ page, request, log, enqueueLinks }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Processing (playwright)', { url });

  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  // Enqueue more game links
  await enqueueLinks({
    globs: ['**/games/**', '**/places/**'],
    transformRequestFunction: (r) => {
      if (followInternalOnly) {
        try {
          const startHost = request.userData.startHost || new URL(request.url).host;
          if (new URL(r.url).host !== startHost) return null;
        } catch (e) { return null; }
      }
      return r;
    }
  });

  // Extract placeId
  const ids = extractIdsFromUrl(url);
  const placeId = ids.placeId || null;

  // Try reading title and meta
  const name = (await page.title().catch(() => '')) || (await page.locator('h1').first().innerText().catch(() => '')) || '';
  // attempt to get online players count (Roblox uses dynamic elements)
  let playing = null;
  try {
    const playingText = await page.locator('[data-testid="game-players-count"], .playing-count, .text-lead').first().innerText().catch(() => '');
    if (playingText) playing = playingText.replace(/[^0-9]/g, '');
  } catch (e) {
    // ignore
  }

  // API enrichment if desired
  let apiData = null;
  if (useApi && placeId) {
    apiData = await fetchRobloxGameApiByPlaceId(placeId);
  }

  const pageData = { name, playing };
  const record = normalizeRecord({ apiData, pageData, url, placeId });
  await dataset.pushData(record);

  try {
    const key = placeId ? `experiences/${placeId}` : `experiences/${encodeURIComponent(url)}`;
    await kv.setValue(key, { url, apiData, pageData }, { contentType: 'application/json' });
  } catch (e) {
    log.warning('Failed to save raw JSON to KV', { url, error: e.message });
  }
}

// Build start requests: from startUrls + experienceIds
const startRequests = [];
for (const u of (startUrls || [])) {
  try {
    const parsed = new URL(u);
    startRequests.push({ url: u, userData: { startHost: parsed.host } });
  } catch (e) {
    // skip invalid url
  }
}
for (const e of (experienceIds || [])) {
  // Construct a canonical Roblox game URL for place id
  const id = typeof e === 'object' ? e.id || e.placeId || e.experienceId : e;
  if (id) startRequests.push({ url: `https://www.roblox.com/games/${id}`, userData: {} });
}

// Choose crawler
if (!useBrowser) {
  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    maxConcurrency: concurrency,
    async requestHandler(ctx) {
      await cheerioHandler(ctx);
    }
  });

  await crawler.run(startRequests);
} else {
  const crawler = new PlaywrightCrawler({
    launchContext: {},
    maxRequestsPerCrawl,
    async requestHandler(ctx) {
      await playwrightHandler(ctx);
    }
  });

  await crawler.run(startRequests);
}

await Actor.exit();
