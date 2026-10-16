// ===================================================================
// src/index.js - Proxy API Worker (Industrial Level v11.0 - FINAL)
// ===================================================================
// v11.0 ARC-AWARE ARCHITECTURE:
//   • AniList relations walk → root series + seasonsBefore
//   • Dual season try: user_season AND absoluteSeason
//   • In-memory AniList cache (5-min, warm worker)
//   • Rate-safe batching (batch=2)
//   • Search-first + guess-fallback + word-trim
//   • All v10.0 features retained
// ===================================================================

const ANIKOTO_API = "https://anikoto-api-bl5m.onrender.com";
const TOONSTREAM_API = "https://toonstream-scraper-5mws.onrender.com";
const TOONSTREAM_SITE = "https://toonstream.us";
const ANILIST_PROXY_URL = "https://gojotv-anilist-proxy.taiwansixtynine0987-arch.deno.net/graphql";

const WORKING_TOONSTREAM_SERVERS = [
  "voe.sx", "vidara.to", "vidc.upns.pro", "abyssplayer.com",
  "filesforever.link", "ravok.buzz", "cloudy.upns.one", "vidmoly.net",
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
const PARALLEL_BATCH_SIZE = 2;
const SCRAPER_FETCH_TIMEOUT_MS = 20000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_PREQUEL_DEPTH = 4;
const ANILIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ⚡ In-memory AniList cache (lives across requests in warm workers)
const ANILIST_CACHE = new Map();

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
    if (path === "/api/root-test") return handleRootTest(url);

    return jsonResponse({
      success: true,
      message: "Proxy API Worker v11.0",
      version: "11.0-industrial",
      architecture: "arc-aware-search-first",
      debug_endpoints: [
        "/api/debug",
        "/api/slug-test",
        "/api/search-test",
        "/api/root-test",
      ],
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
    if (item === null || item === undefined) continue;
    const s = String(item).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ===================================================================
// ANILIST — fetch media with cache
// ===================================================================
async function fetchAniListMedia(anilistId) {
  if (!anilistId || parseInt(anilistId) <= 0) return null;
  const idNum = parseInt(anilistId);

  // Cache check
  const cached = ANILIST_CACHE.get(idNum);
  if (cached && Date.now() - cached.ts < ANILIST_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const gqlQuery = {
      query: `query($id: Int) {
        Media(id: $id) {
          id
          format
          startDate { year }
          seasonYear
          title { romaji english }
          relations {
            edges {
              relationType
              node {
                id
                format
                title { romaji english }
                startDate { year }
              }
            }
          }
        }
      }`,
      variables: { id: idNum },
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
    const media = json?.data?.Media || null;

    // Save to cache
    ANILIST_CACHE.set(idNum, { data: media, ts: Date.now() });
    return media;
  } catch (e) {
    return null;
  }
}

// ===================================================================
// ROOT SERIES DETECTION — walk PREQUEL chain (TV format only)
// ===================================================================
async function findRootSeriesInfo(anilistId, depth = 0, visited = new Set()) {
  if (depth > MAX_PREQUEL_DEPTH) return null;
  const idNum = parseInt(anilistId);
  if (!idNum || visited.has(idNum)) return null;
  visited.add(idNum);

  const media = await fetchAniListMedia(idNum);
  if (!media) return null;

  const tvPrequels = (media.relations?.edges || [])
    .filter(
      (e) =>
        e.relationType === "PREQUEL" &&
        e.node?.format === "TV" &&
        e.node?.id
    )
    .sort((a, b) => {
      const ya = a.node.startDate?.year || 9999;
      const yb = b.node.startDate?.year || 9999;
      return yb - ya; // Most recent first
    });

  if (tvPrequels.length === 0) {
    // We are the root
    return {
      rootId: media.id,
      rootTitleRomaji: media.title?.romaji || "",
      rootTitleEnglish: media.title?.english || "",
      seasonsBefore: 0,
    };
  }

  const parentInfo = await findRootSeriesInfo(
    tvPrequels[0].node.id,
    depth + 1,
    visited
  );
  if (!parentInfo) return null;

  return {
    rootId: parentInfo.rootId,
    rootTitleRomaji: parentInfo.rootTitleRomaji,
    rootTitleEnglish: parentInfo.rootTitleEnglish,
    seasonsBefore: parentInfo.seasonsBefore + 1,
  };
}

// ===================================================================
// TOONSTREAM SEARCH — returns { slug, title, type, year }
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
// BATCHED SLUG TRY — rate-safe (batch=2 parallel, sequential)
// ===================================================================
async function trySlugJobs(jobs, bestSoFar, targetCount) {
  let best = bestSoFar || { slug: null, servers: [] };
  for (let i = 0; i < jobs.length; i += PARALLEL_BATCH_SIZE) {
    const batch = jobs.slice(i, i + PARALLEL_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (job) => {
        const raw = await fetchToonStreamServers(job.slug, job.season, job.episode);
        return { slug: job.slug, servers: buildToonStreamServers(raw) };
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
// PHASE 1 — SEARCH-FIRST (v10.0 IDENTICAL)
// ===================================================================
async function phase1SearchFirst(titleEnglish, titleRomaji, slug, season, episode, isMovieRequest, year) {
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
    if (allSearchResults.length >= 8) break;
  }

  const filteredByType = allSearchResults.filter((r) => {
    if (isMovieRequest) return r.type === "movie";
    return r.type === "series";
  });

  const jobs = [];
  const added = new Set();
  const pushJob = (s) => {
    if (!s || added.has(s)) return;
    added.add(s);
    jobs.push({ slug: s, season, episode });
  };

  for (const r of filteredByType) {
    pushJob(r.slug);
    if (r.year) pushJob(`${r.slug}-${r.year}`);
    if (year && year !== r.year) pushJob(`${r.slug}-${year}`);
  }

  if (jobs.length === 0) {
    return {
      best: { slug: null, servers: [] },
      searchResults: allSearchResults,
      addedSlugs: added,
    };
  }

  const best = await trySlugJobs(jobs, { slug: null, servers: [] }, 6);
  return { best, searchResults: allSearchResults, addedSlugs: added };
}

// ===================================================================
// PHASE 1b — ARC-AWARE (only if Phase 1 weak)
// ===================================================================
async function phase1bArcAware(rootInfo, userSeason, episode, isMovieRequest, year, addedSlugs) {
  if (!rootInfo || (!rootInfo.rootTitleEnglish && !rootInfo.rootTitleRomaji)) {
    return { best: { slug: null, servers: [] }, addedSlugs };
  }

  const rootTitles = dedupeArray([
    rootInfo.rootTitleEnglish,
    rootInfo.rootTitleRomaji,
  ]);

  const rootSearchResults = [];
  const seenRootSlugs = new Set();
  for (const t of rootTitles) {
    const results = await searchToonStreamResults(t);
    for (const r of results) {
      if (seenRootSlugs.has(r.slug)) continue;
      seenRootSlugs.add(r.slug);
      rootSearchResults.push(r);
    }
  }

  const filtered = rootSearchResults.filter((r) => {
    if (isMovieRequest) return r.type === "movie";
    return r.type === "series";
  });

  const absoluteSeason = userSeason + (rootInfo.seasonsBefore || 0);
  const seasonsToTry = dedupeArray([absoluteSeason, userSeason]);

  const jobs = [];
  for (const r of filtered) {
    if (addedSlugs.has(r.slug)) continue;
    addedSlugs.add(r.slug);
    for (const s of seasonsToTry) {
      jobs.push({ slug: r.slug, season: s, episode });
    }
    if (r.year) {
      const yearSlug = `${r.slug}-${r.year}`;
      if (!addedSlugs.has(yearSlug)) {
        addedSlugs.add(yearSlug);
        for (const s of seasonsToTry) {
          jobs.push({ slug: yearSlug, season: s, episode });
        }
      }
    }
  }

  if (jobs.length === 0) {
    return { best: { slug: null, servers: [] }, addedSlugs };
  }

  const best = await trySlugJobs(jobs, { slug: null, servers: [] }, 6);
  return { best, addedSlugs };
}
// ===================================================================
// PHASE 2 — GUESS-BASED FALLBACK (only if best < 3)
// ===================================================================
async function phase2GuessFallback(titleEnglish, titleRomaji, slug, season, episode, year, addedSlugs) {
  const guessSlugs = [];
  const pushGuess = (s) => {
    if (!s || addedSlugs.has(s)) return;
    addedSlugs.add(s);
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

    pushGuess(s1);
    pushGuess(s2);
    pushGuess(s3);

    if (year) {
      pushGuess(`${s1}-${year}`);
      pushGuess(`${s2}-${year}`);
      pushGuess(`${s3}-${year}`);
    }
  }

  if (slug) {
    pushGuess(slug);
    const normSlug = normalizeSlug(slug);
    if (normSlug !== slug) pushGuess(normSlug);
    if (year) {
      pushGuess(`${slug}-${year}`);
      if (normSlug !== slug) pushGuess(`${normSlug}-${year}`);
    }
  }

  const jobs = guessSlugs.map((s) => ({ slug: s, season, episode }));
  return await trySlugJobs(jobs, { slug: null, servers: [] }, 5);
}

// ===================================================================
// PHASE 3 — WORD-TRIM FALLBACK (only if best < 3)
// ===================================================================
async function phase3WordTrim(titleEnglish, titleRomaji, season, episode, isMovieRequest, addedSlugs) {
  let best = { slug: null, servers: [] };
  const longestTitle =
    titleEnglish && titleEnglish.length > (titleRomaji || "").length
      ? titleEnglish
      : titleRomaji || titleEnglish;

  if (!longestTitle) return best;

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
      if (addedSlugs.has(r.slug)) continue;
      addedSlugs.add(r.slug);
      const raw = await fetchToonStreamServers(r.slug, season, episode);
      const built = buildToonStreamServers(raw);
      if (built.length > best.servers.length) {
        best = { slug: r.slug, servers: built };
      }
    }
    if (best.servers.length >= 5) break;
  }
  return best;
}

// ===================================================================
// TOONSTREAM MAIN — Arc-Aware Search-First (v11.0)
// ===================================================================
async function getToonStreamLinks(slug, season, episode, titleRomaji, titleEnglish, anilistMeta, rootInfo) {
  const isMovieRequest = anilistMeta?.format === "MOVIE";
  const year = anilistMeta?.year || null;

  // ============================================================
  // PHASE 1: SEARCH-FIRST (v10.0 IDENTICAL)
  // ============================================================
  const p1 = await phase1SearchFirst(
    titleEnglish, titleRomaji, slug, season, episode, isMovieRequest, year
  );
  let best = p1.best;
  const addedSlugs = p1.addedSlugs;

  // ✅ Early exit if we already have enough (v10.0's success case)
  if (best.servers.length >= 5) return best.servers;

  // ============================================================
  // PHASE 1b: ARC-AWARE (only if Phase 1 weak AND arc detected)
  // ============================================================
  if (best.servers.length < 5 && rootInfo && (rootInfo.seasonsBefore || 0) > 0) {
    const p1b = await phase1bArcAware(
      rootInfo, season, episode, isMovieRequest, year, addedSlugs
    );
    if (p1b.best.servers.length > best.servers.length) best = p1b.best;
    if (best.servers.length >= 5) return best.servers;
  }

  // ============================================================
  // PHASE 2: GUESS-BASED FALLBACK (only if best < 3)
  // ============================================================
  if (best.servers.length < 3) {
    const p2 = await phase2GuessFallback(
      titleEnglish, titleRomaji, slug, season, episode, year, addedSlugs
    );
    if (p2.servers.length > best.servers.length) best = p2;
    if (best.servers.length >= 5) return best.servers;
  }

  // ============================================================
  // PHASE 3: WORD-TRIM FALLBACK (only if best < 3)
  // ============================================================
  if (best.servers.length < 3) {
    const p3 = await phase3WordTrim(
      titleEnglish, titleRomaji, season, episode, isMovieRequest, addedSlugs
    );
    if (p3.servers.length > best.servers.length) best = p3;
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
  let rootInfo = null;
  if (anilistId) {
    const media = await fetchAniListMedia(anilistId);
    if (media) {
      meta = {
        format: media.format,
        year: media.startDate?.year || media.seasonYear,
      };
      rootInfo = await findRootSeriesInfo(anilistId);
    }
  }

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
    version: "11.0-industrial",
    input: { slug, titleRomaji, titleEnglish, anilistId },
    anilist_meta: meta,
    root_series_info: rootInfo,
    toonstream_search_results: searchResults,
    architecture: "arc-aware-search-first",
  });
}

async function handleSlugTest(url) {
  const params = url.searchParams;
  const slug = params.get("slug") || "";
  const season = parseInt(params.get("season") || "1");
  const episode = parseInt(params.get("episode") || "1");

  if (!slug) return jsonResponse({ success: false, error: "Missing slug" }, 400);

  const raw = await fetchToonStreamServers(slug, season, episode);
  const built = buildToonStreamServers(raw);

  return jsonResponse({
    success: true,
    slug, season, episode,
    raw_count: raw.length,
    approved_count: built.length,
    raw_servers: raw.map((r) => r.embed_url),
    approved_servers: built.map((b) => ({ name: b.server_name, url: b.embed_url })),
  });
}

async function handleSearchTest(url) {
  const params = url.searchParams;
  const title = params.get("title") || "";
  if (!title) return jsonResponse({ success: false, error: "Missing title" }, 400);
  const results = await searchToonStreamResults(title);
  return jsonResponse({ success: true, title, count: results.length, results });
}

async function handleRootTest(url) {
  const params = url.searchParams;
  const anilistId = params.get("anilist_id") || "";
  if (!anilistId) return jsonResponse({ success: false, error: "Missing anilist_id" }, 400);
  const rootInfo = await findRootSeriesInfo(anilistId);
  return jsonResponse({ success: true, anilist_id: anilistId, root_series_info: rootInfo });
}
