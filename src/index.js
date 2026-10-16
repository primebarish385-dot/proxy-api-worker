// ===================================================================
// src/index.js - Proxy API Worker (Industrial Level v10.0 - FINAL)
// ===================================================================
// v10.0 NEW ARCHITECTURE:
//   • PHASE 1: SEARCH-FIRST (ToonStream exact slug from Search API)
//   • Content type filter: AniList TV → series, MOVIE → movie
//   • Year variants auto-added (vinland-saga + vinland-saga-2019)
//   • Rate-limit safe: batch=2 parallel max
//   • PHASE 2: Guess-based fallback (if search returns nothing)
//   • PHASE 3: Progressive word-trim (last resort)
//   • All v9.0 features retained
// ===================================================================

const ANIKOTO_API = "https://anikoto-api-bl5m.onrender.com";
const TOONSTREAM_API = "https://toonstream-scraper-5mws.onrender.com";
const TOONSTREAM_SITE = "https://toonstream.us";
const ANILIST_PROXY_URL = "https://gojotv-anilist-proxy.taiwansixtynine0987-arch.deno.net/graphql";

const WORKING_TOONSTREAM_SERVERS = [
  "voe.sx",
  "vidara.to",
  "vidc.upns.pro",
  "abyssplayer.com",
  "filesforever.link",
  "ravok.buzz",
  "cloudy.upns.one",
  "vidmoly.net",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MIN_MATCH_SCORE = 55;
const MAX_ANIKOTO_RESULTS = 3;
const PARALLEL_BATCH_SIZE = 2;       // ⚡ Rate-limit safe
const SCRAPER_FETCH_TIMEOUT_MS = 20000;  // ⚡ Give scraper time to respond
const FETCH_TIMEOUT_MS = 15000;

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "and", "to", "in", "on", "for",
  "with", "by", "at", "from", "as", "is", "it", "its",
  "movie", "series", "episode", "anime", "ova", "ona", "special",
]);

const TITLE_ALIASES = {
  "aot": "attack on titan",
  "jjk": "jujutsu kaisen",
  "mha": "my hero academia",
  "fmab": "fullmetal alchemist brotherhood",
  "hxh": "hunter x hunter",
  "op": "one piece",
  "ds": "demon slayer",
  "kny": "kimetsu no yaiba",
  "tbhk": "toilet bound hanako kun",
};

// ===================================================================
// ENTRY POINT
// ===================================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/proxy") return handleProxy(url);
    if (path === "/api/streaming" || path === "/api") return handleStreamingAPI(url);
    if (path === "/api/debug") return handleDebug(url);
    if (path === "/api/slug-test") return handleSlugTest(url);
    if (path === "/api/search-test") return handleSearchTest(url);

    return jsonResponse({
      success: true,
      message: "Proxy API Worker v10.0",
      version: "10.0-industrial",
      sources: ["anikoto", "toonstream"],
      working_servers: WORKING_TOONSTREAM_SERVERS.length,
      architecture: "search-first",
      debug_endpoints: ["/api/debug", "/api/slug-test", "/api/search-test"],
    });
  },
};

// ===================================================================
// UTILITIES
// ===================================================================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

async function fetchJSON(url, extraHeaders = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...extraHeaders },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function similarityScore(a, b) {
  if (!a || !b) return 0;
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 100;
  const maxLen = Math.max(s1.length, s2.length);
  const distance = levenshtein(s1, s2);
  const levScore = ((maxLen - distance) / maxLen) * 100;
  const set1 = new Set(s1.split(/\s+/).filter((t) => t.length > 0));
  const set2 = new Set(s2.split(/\s+/).filter((t) => t.length > 0));
  const intersection = [...set1].filter((t) => set2.has(t)).length;
  const union = new Set([...set1, ...set2]).size;
  const tokenScore = union > 0 ? (intersection / union) * 100 : 0;
  let bonus = 0;
  if (s1.includes(s2) || s2.includes(s1)) bonus = 15;
  return Math.min(100, Math.round(levScore * 0.5 + tokenScore * 0.5 + bonus));
}

function removeStopWords(title) {
  return title.toLowerCase().split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .join(" ").trim();
}

function applyAlias(title) {
  const lower = title.toLowerCase().trim();
  return TITLE_ALIASES[lower] || title;
}

function normalizeSlug(slug) {
  let s = slug.toLowerCase().trim();
  const patterns = [
    /-(\d+)(st|nd|rd|th)-season$/, /-season-\d+$/, /-the-final-season$/,
    /-final-season-part-\d+$/, /-final-season$/, /-part-\d+$/, /-cour-\d+$/,
    /-\d+nd-season$/, /-\d+rd-season$/, /-\d+th-season$/, /-season$/,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of patterns) {
      const next = s.replace(p, "");
      if (next !== s) { s = next; changed = true; }
    }
  }
  return s;
}

function normalizeTitle(title) {
  let t = title.trim();
  const patterns = [
    /\s+\d+(st|nd|rd|th)\s+Season$/i, /\s+Season\s+\d+\s+Part\s+\d+$/i,
    /\s+Season\s+\d+$/i, /\s+The\s+Final\s+Season$/i,
    /\s+Final\s+Season\s+Part\s+\d+$/i, /\s+Final\s+Season$/i,
    /\s+Part\s+\d+$/i, /\s+Cour\s+\d+$/i, /\s+Season$/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of patterns) {
      const next = t.replace(p, "");
      if (next !== t) { t = next; changed = true; }
    }
  }
  return t.trim();
}

function toSlug(s) {
  if (!s) return "";
  return s.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractSlugFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/(?:series|movies|episode)\/([^\/\?]+)/);
  return m && m[1] ? m[1] : null;
}

function extractYearFromTitle(title) {
  if (!title) return null;
  const m = title.match(/\((\d{4})\)/);
  return m ? parseInt(m[1]) : null;
}

function dedupeArray(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (!item) continue;
    const s = String(item).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ===================================================================
// ANILIST PROXY — fetch format + year
// ===================================================================
async function fetchAniListMeta(anilistId) {
  if (!anilistId || parseInt(anilistId) <= 0) return null;
  try {
    const gqlQuery = {
      query: `query($id: Int) { Media(id: $id) { format startDate { year } seasonYear } }`,
      variables: { id: parseInt(anilistId) },
    };
    const res = await fetch(ANILIST_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(gqlQuery),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const media = json?.data?.Media;
    if (!media) return null;
    const format = (media.format || "").toUpperCase();
    if (format !== "TV" && format !== "MOVIE") return null;
    const year = media.startDate?.year || media.seasonYear || null;
    return { format, year };
  } catch (e) {
    return null;
  }
}

// ===================================================================
// TOONSTREAM SEARCH — returns array of { slug, title, type, year }
// ===================================================================
async function searchToonStreamResults(title) {
  if (!title) return [];
  try {
    const searchUrl = `${TOONSTREAM_SITE}/search/all?q=${encodeURIComponent(title)}`;
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        Referer: `${TOONSTREAM_SITE}/`,
      },
    });
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json.data) || json.data.length === 0) return [];

    const results = [];
    for (const item of json.data) {
      const slug = extractSlugFromUrl(item.url);
      if (!slug) continue;
      results.push({
        slug,
        title: (item.title || "").trim(),
        type: (item.type || "").trim().toLowerCase(),
        year: extractYearFromTitle(item.title),
      });
    }
    return results;
  } catch (e) {
    return [];
  }
}
// ===================================================================
// TOONSTREAM HELPERS
// ===================================================================
function getToonStreamServerName(url) {
  if (url.includes("voe.sx")) return "VOE";
  if (url.includes("vidara.to")) return "Vidara";
  if (url.includes("vidc.upns.pro")) return "Vidc";
  if (url.includes("abyssplayer.com")) return "Abyss";
  if (url.includes("filesforever.link")) return "FilesForever";
  if (url.includes("ravok.buzz")) return "Ravok";
  if (url.includes("cloudy.upns.one")) return "Cloudy";
  if (url.includes("vidmoly.net")) return "Vidmoly";
  return "Unknown";
}

async function fetchToonStreamServers(slug, season, episode) {
  try {
    const apiUrl = `${TOONSTREAM_API}/api/streaming?slug=${encodeURIComponent(slug)}&season=${season}&episode=${episode}`;
    const data = await fetchJSON(apiUrl, {}, SCRAPER_FETCH_TIMEOUT_MS);
    if (data?.success && data.data?.servers?.length > 0) {
      return data.data.servers;
    }
  } catch (e) {}
  return [];
}

function buildToonStreamServers(rawServers) {
  const workingUrls = [];
  const seenUrls = new Set();

  for (const server of rawServers) {
    const originalUrl = server.embed_url;
    if (!originalUrl) continue;
    if (seenUrls.has(originalUrl)) continue;
    const isWorking = WORKING_TOONSTREAM_SERVERS.some((domain) =>
      originalUrl.includes(domain)
    );
    if (!isWorking) continue;
    seenUrls.add(originalUrl);
    workingUrls.push(originalUrl);
  }

  if (workingUrls.length === 0) return [];

  const domainCounts = {};
  for (const url of workingUrls) {
    const baseName = getToonStreamServerName(url);
    domainCounts[baseName] = (domainCounts[baseName] || 0) + 1;
  }

  const domainIndexes = {};
  const servers = [];
  for (const originalUrl of workingUrls) {
    const baseName = getToonStreamServerName(originalUrl);
    let finalName = baseName;
    if (domainCounts[baseName] > 1) {
      domainIndexes[baseName] = (domainIndexes[baseName] || 0) + 1;
      finalName = `${baseName} ${domainIndexes[baseName]}`;
    }
    servers.push({
      server_name: `ToonStream - ${finalName}`,
      source: "toonstream",
      type: "dub",
      language: "multi-audio",
      embed_url: originalUrl,
      ready_to_use: true,
    });
  }
  return servers;
}

// ===================================================================
// HELPER: Try slugs in rate-limit-safe batches, return best
// ===================================================================
async function trySlugsInBatches(slugList, season, episode, bestSoFar, targetCount) {
  let best = bestSoFar || { slug: null, servers: [] };
  for (let i = 0; i < slugList.length; i += PARALLEL_BATCH_SIZE) {
    const batch = slugList.slice(i, i + PARALLEL_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (s) => {
        const raw = await fetchToonStreamServers(s, season, episode);
        return { slug: s, servers: buildToonStreamServers(raw) };
      })
    );
    for (const r of results) {
      if (r.servers.length > best.servers.length) best = r;
    }
    if (best.servers.length >= targetCount) break;
  }
  return best;
}

// ===================================================================
// TOONSTREAM MAIN — v10.0 SEARCH-FIRST ARCHITECTURE
// ===================================================================
async function getToonStreamLinks(slug, season, episode, titleRomaji, titleEnglish, anilistMeta) {
  const isMovieRequest = anilistMeta?.format === "MOVIE";
  const year = anilistMeta?.year || null;

  // ============================================================
  // PHASE 1: SEARCH-FIRST (ToonStream exact slugs from Search API)
  // ============================================================
  const searchTitles = dedupeArray([
    titleEnglish,
    titleRomaji,
    slug ? slug.replace(/-/g, " ") : null,
  ]);

  const allSearchResults = [];
  const seenSlugs = new Set();

  for (const title of searchTitles) {
    const results = await searchToonStreamResults(title);
    for (const r of results) {
      if (seenSlugs.has(r.slug)) continue;
      seenSlugs.add(r.slug);
      allSearchResults.push(r);
    }
    if (allSearchResults.length >= 6) break;
  }

  // Filter by content type: TV→series, MOVIE→movie
  const filteredByType = allSearchResults.filter((r) => {
    if (isMovieRequest) return r.type === "movie";
    return r.type === "series";
  });

  // Build slug list with year variants (priority: exact match first)
  const searchSlugs = [];
  const searchAdded = new Set();
  const pushSearchSlug = (s) => {
    if (!s || searchAdded.has(s)) return;
    searchAdded.add(s);
    searchSlugs.push(s);
  };

  for (const r of filteredByType) {
    pushSearchSlug(r.slug);
    if (r.year) pushSearchSlug(`${r.slug}-${r.year}`);
    if (year && year !== r.year) pushSearchSlug(`${r.slug}-${year}`);
  }

  let best = { slug: null, servers: [] };
  if (searchSlugs.length > 0) {
    best = await trySlugsInBatches(searchSlugs, season, episode, best, 5);
    // If found enough, return immediately
    if (best.servers.length >= 5) return best.servers;
  }

  // ============================================================
  // PHASE 2: GUESS-BASED FALLBACK (only if search missed)
  // ============================================================
  if (best.servers.length < 3) {
    const guessSlugs = [];
    const guessAdded = new Set();
    const pushGuessSlug = (s) => {
      if (!s || guessAdded.has(s) || searchAdded.has(s)) return;
      guessAdded.add(s);
      guessSlugs.push(s);
    };

    for (const t of [titleEnglish, titleRomaji]) {
      if (!t) continue;
      const aliasT = applyAlias(t);
      const normT = normalizeTitle(aliasT);
      const cleanT = removeStopWords(normT);

      const s1 = toSlug(t);
      const s2 = toSlug(normT);
      const s3 = toSlug(cleanT);

      pushGuessSlug(s1);
      pushGuessSlug(s2);
      pushGuessSlug(s3);

      if (year) {
        pushGuessSlug(`${s1}-${year}`);
        pushGuessSlug(`${s2}-${year}`);
        pushGuessSlug(`${s3}-${year}`);
      }
    }

    if (slug) {
      pushGuessSlug(slug);
      const normSlug = normalizeSlug(slug);
      if (normSlug !== slug) pushGuessSlug(normSlug);
      if (year) {
        pushGuessSlug(`${slug}-${year}`);
        if (normSlug !== slug) pushGuessSlug(`${normSlug}-${year}`);
      }
    }

    if (guessSlugs.length > 0) {
      best = await trySlugsInBatches(guessSlugs, season, episode, best, 5);
    }
  }

  // ============================================================
  // PHASE 3: PROGRESSIVE WORD-TRIM (last resort)
  // ============================================================
  if (best.servers.length < 3) {
    const longestTitle =
      titleEnglish && titleEnglish.length > (titleRomaji || "").length
        ? titleEnglish
        : titleRomaji || titleEnglish;

    if (longestTitle) {
      const normTitle = normalizeTitle(applyAlias(longestTitle));
      const words = normTitle.split(/\s+/).filter((w) => w.length > 0);

      for (let i = words.length - 1; i >= 2; i--) {
        const shortTitle = words.slice(0, i).join(" ");
        if (similarityScore(longestTitle, shortTitle) < 60) continue;

        const results = await searchToonStreamResults(shortTitle);
        const filtered = results.filter((r) => {
          if (isMovieRequest) return r.type === "movie";
          return r.type === "series";
        });

        for (const r of filtered) {
          if (searchAdded.has(r.slug) || guessAdded.has(r.slug)) continue;
          const raw = await fetchToonStreamServers(r.slug, season, episode);
          const built = buildToonStreamServers(raw);
          if (built.length > best.servers.length) {
            best = { slug: r.slug, servers: built };
          }
        }
        if (best.servers.length >= 5) break;
      }
    }
  }

  return best.servers;
}

// ===================================================================
// ANIKOTO — Multi-Result Fallback
// ===================================================================
async function getAnikotoLinks(titleRomaji, titleEnglish, episode) {
  const titlesToTry = [titleRomaji, titleEnglish].filter(
    (t, i, arr) => t && arr.indexOf(t) === i
  );

  for (const title of titlesToTry) {
    const searchUrl = `${ANIKOTO_API}/api/search?q=${encodeURIComponent(title)}`;
    const searchData = await fetchJSON(searchUrl);

    if (!searchData?.success || !searchData.data?.results?.length) continue;

    const ranked = searchData.data.results
      .slice(0, MAX_ANIKOTO_RESULTS + 2)
      .map((r) => ({
        ...r,
        score: Math.max(
          similarityScore(title, (r.title || "").toLowerCase()),
          similarityScore(title, (r.slug || "").replace(/-/g, " "))
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ANIKOTO_RESULTS);

    for (const result of ranked) {
      const episodeUrl = `${ANIKOTO_API}/api/episode/${result.slug}/${episode}`;
      const episodeData = await fetchJSON(episodeUrl);

      if (!episodeData?.success || !episodeData.data?.servers?.length) continue;

      const servers = [];
      for (const server of episodeData.data.servers) {
        let embedUrl = server.embedUrl || server.embed_url;
        if (!embedUrl) continue;

        if (embedUrl.includes("megaplay.buzz/stream/")) {
          embedUrl = embedUrl.replace(
            "megaplay.buzz/stream/",
            "megaplay.buzz/videojs/stream/"
          );
        }

        servers.push({
          server_name: `Anikoto - ${server.name || "Server"}`,
          source: "anikoto",
          type: server.type || "sub",
          language: "english",
          embed_url: embedUrl,
          ready_to_use: true,
        });
      }

      if (servers.length > 0) return servers;
    }
  }

  return [];
}

// ===================================================================
// DEBUG ENDPOINTS
// ===================================================================
async function handleDebug(url) {
  const params = url.searchParams;
  const slug = params.get("slug") || "";
  const titleRomaji = params.get("title_romaji") || "";
  const titleEnglish = params.get("title_english") || "";
  const anilistId = params.get("anilist_id") || "";

  let meta = null;
  if (anilistId) meta = await fetchAniListMeta(anilistId);

  const searchResults = [];
  const seen = new Set();
  for (const t of dedupeArray([titleEnglish, titleRomaji])) {
    const results = await searchToonStreamResults(t);
    for (const r of results) {
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      searchResults.push(r);
    }
  }

  return jsonResponse({
    success: true,
    version: "10.0-industrial",
    input: { slug, titleRomaji, titleEnglish, anilistId },
    anilist_meta: meta,
    toonstream_search_results: searchResults,
    architecture: "search-first",
  });
}

async function handleSlugTest(url) {
  const params = url.searchParams;
  const slug = params.get("slug") || "";
  const season = parseInt(params.get("season") || "1");
  const episode = parseInt(params.get("episode") || "1");

  if (!slug) {
    return jsonResponse({ success: false, error: "Missing slug" }, 400);
  }

  const raw = await fetchToonStreamServers(slug, season, episode);
  const built = buildToonStreamServers(raw);

  return jsonResponse({
    success: true,
    slug,
    season,
    episode,
    raw_count: raw.length,
    approved_count: built.length,
    raw_servers: raw.map((r) => r.embed_url),
    approved_servers: built.map((b) => ({
      name: b.server_name,
      url: b.embed_url,
    })),
  });
}

async function handleSearchTest(url) {
  const params = url.searchParams;
  const title = params.get("title") || "";
  if (!title) {
    return jsonResponse({ success: false, error: "Missing title" }, 400);
  }
  const results = await searchToonStreamResults(title);
  return jsonResponse({
    success: true,
    title,
    count: results.length,
    results,
  });
}

// ===================================================================
// PROXY HANDLER
// ===================================================================
async function handleProxy(url) {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ success: false, error: "Missing 'url' parameter" }, 400);
  }

  try {
    const targetURL = new URL(targetUrl);
    const headers = new Headers();
    headers.set("User-Agent", USER_AGENT);
    headers.set(
      "Accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    );
    headers.set("Accept-Language", "en-US,en;q=0.9");
    headers.set("Referer", targetURL.origin + "/");

    const response = await fetch(targetUrl, { headers, redirect: "follow" });
    const newHeaders = new Headers(response.headers);
    newHeaders.delete("X-Frame-Options");
    newHeaders.delete("Content-Security-Policy");
    newHeaders.delete("Content-Security-Policy-Report-Only");
    newHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  } catch (e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

// ===================================================================
// MAIN STREAMING API HANDLER
// ===================================================================
async function handleStreamingAPI(url) {
  const params = url.searchParams;
  const anilistId = params.get("anilist_id");
  const slug = params.get("slug") || "";
  const titleEnglish = params.get("title_english") || params.get("title") || "";
  const titleRomaji = params.get("title_romaji") || "";
  const season = parseInt(params.get("season") || "1");
  const episode = parseInt(params.get("episode") || "1");

  if (!slug && !titleEnglish && !titleRomaji) {
    return jsonResponse(
      { success: false, error: "Need at least 'slug' or 'title'" },
      400
    );
  }

  const anikotoTitleRomaji =
    titleRomaji || titleEnglish || slug.replace(/-/g, " ");
  const anikotoTitleEnglish =
    titleEnglish || titleRomaji || slug.replace(/-/g, " ");

  const toonTitleRomaji =
    titleRomaji || titleEnglish || slug.replace(/-/g, " ");
  const toonTitleEnglish =
    titleEnglish || titleRomaji || slug.replace(/-/g, " ");

  let anilistMeta = null;
  if (anilistId && parseInt(anilistId) > 0) {
    anilistMeta = await fetchAniListMeta(anilistId);
  }

  const [anikotoServers, toonstreamServers] = await Promise.all([
    getAnikotoLinks(anikotoTitleRomaji, anikotoTitleEnglish, episode),
    slug
      ? getToonStreamLinks(
          slug,
          season,
          episode,
          toonTitleRomaji,
          toonTitleEnglish,
          anilistMeta
        )
      : Promise.resolve([]),
  ]);

  const subServers = anikotoServers.filter((s) => s.type === "sub");
  const dubServers = [
    ...anikotoServers.filter((s) => s.type === "dub"),
    ...toonstreamServers,
  ];

  const allServers = [...anikotoServers, ...toonstreamServers];

  return jsonResponse({
    success: allServers.length > 0,
    data: {
      anilist_id: anilistId,
      slug: slug,
      title_english: titleEnglish,
      title_romaji: titleRomaji,
      season: season,
      episode: episode,
      anilist_format: anilistMeta?.format || null,
      release_year: anilistMeta?.year || null,
      total_servers: allServers.length,
      sub_count: subServers.length,
      dub_count: dubServers.length,
      servers: allServers,
    },
  });
}
