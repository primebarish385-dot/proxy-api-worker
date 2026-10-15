// ===================================================================
// src/index.js - Proxy API Worker (Industrial Level v5.1)
// ===================================================================
// v5.1 Improvements over v5.0:
//   • Levenshtein distance similarity
//   • Token-overlap scoring
//   • Stop-word removal for matching
//   • Multi-query search expansion
//   • Confidence threshold (70%+ match required)
//   • Common alias mapping
//   • Progressive word-trim with score validation
// ===================================================================

const ANIKOTO_API = "https://anikoto-api-bl5m.onrender.com";
const TOONSTREAM_API = "https://toonstream-scraper-5mws.onrender.com";
const TOONSTREAM_SITE = "https://toonstream.us";

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

// Minimum similarity score (0-100) to accept a match
const MIN_MATCH_SCORE = 70;

// Stop words to ignore during matching
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "and", "to", "in", "on", "for",
  "with", "by", "at", "from", "as", "is", "it", "its",
  "movie", "series", "episode", "anime", "ova", "ona", "special",
]);

// Common alias/short form mappings
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
  "rent a girlfriend": "kanojo okarishimasu",
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

    return jsonResponse({
      success: true,
      message: "Proxy API Worker is running",
      version: "5.1-industrial",
      sources: ["anikoto", "toonstream"],
      working_servers: WORKING_TOONSTREAM_SERVERS.length,
      min_match_score: MIN_MATCH_SCORE,
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

async function fetchJSON(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...extraHeaders },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// -------------------------------------------------------------------
// Levenshtein Distance (edit distance)
// -------------------------------------------------------------------
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

// -------------------------------------------------------------------
// Similarity Score (0-100) - combines multiple signals
// -------------------------------------------------------------------
function similarityScore(a, b) {
  if (!a || !b) return 0;

  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();

  if (s1 === s2) return 100;

  // Levenshtein-based score
  const maxLen = Math.max(s1.length, s2.length);
  const distance = levenshtein(s1, s2);
  const levScore = ((maxLen - distance) / maxLen) * 100;

  // Token-overlap score
  const tokens1 = s1.split(/\s+/).filter((t) => t.length > 0);
  const tokens2 = s2.split(/\s+/).filter((t) => t.length > 0);
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  const intersection = [...set1].filter((t) => set2.has(t)).length;
  const union = new Set([...set1, ...set2]).size;
  const tokenScore = union > 0 ? (intersection / union) * 100 : 0;

  // Substring bonus
  let substringBonus = 0;
  if (s1.includes(s2) || s2.includes(s1)) substringBonus = 15;

  // Combined score (weighted average)
  const finalScore = levScore * 0.5 + tokenScore * 0.5 + substringBonus;
  return Math.min(100, Math.round(finalScore));
}

// -------------------------------------------------------------------
// Remove stop words from title
// -------------------------------------------------------------------
function removeStopWords(title) {
  return title
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .join(" ")
    .trim();
}

// -------------------------------------------------------------------
// Apply alias mapping
// -------------------------------------------------------------------
function applyAlias(title) {
  const lower = title.toLowerCase().trim();
  if (TITLE_ALIASES[lower]) return TITLE_ALIASES[lower];
  return title;
}

// -------------------------------------------------------------------
// SLUG NORMALIZATION
// -------------------------------------------------------------------
function normalizeSlug(slug) {
  let s = slug.toLowerCase().trim();
  const patterns = [
    /-(\d+)(st|nd|rd|th)-season$/,
    /-season-\d+$/,
    /-the-final-season$/,
    /-final-season-part-\d+$/,
    /-final-season$/,
    /-part-\d+$/,
    /-cour-\d+$/,
    /-\d+nd-season$/,
    /-\d+rd-season$/,
    /-\d+th-season$/,
    /-season$/,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of patterns) {
      const next = s.replace(p, "");
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  return s;
}

// -------------------------------------------------------------------
// TITLE NORMALIZATION
// -------------------------------------------------------------------
function normalizeTitle(title) {
  let t = title.trim();
  const patterns = [
    /\s+\d+(st|nd|rd|th)\s+Season$/i,
    /\s+Season\s+\d+\s+Part\s+\d+$/i,
    /\s+Season\s+\d+$/i,
    /\s+The\s+Final\s+Season$/i,
    /\s+Final\s+Season\s+Part\s+\d+$/i,
    /\s+Final\s+Season$/i,
    /\s+Part\s+\d+$/i,
    /\s+Cour\s+\d+$/i,
    /\s+Season$/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of patterns) {
      const next = t.replace(p, "");
      if (next !== t) {
        t = next;
        changed = true;
      }
    }
  }
  return t.trim();
}

// -------------------------------------------------------------------
// SLUG CANDIDATES - Multiple variations
// -------------------------------------------------------------------
function getSlugCandidates(slug, title) {
  const candidates = new Set();
  const normSlug = normalizeSlug(slug);
  const aliasTitle = applyAlias(title);
  const normTitle = normalizeTitle(aliasTitle);
  const cleanTitle = removeStopWords(normTitle);

  function toSlug(s) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  if (slug) candidates.add(slug);
  if (normSlug && normSlug !== slug) candidates.add(normSlug);
  if (normTitle) candidates.add(toSlug(normTitle));
  if (cleanTitle) candidates.add(toSlug(cleanTitle));
  if (title) candidates.add(toSlug(title));

  return Array.from(candidates).filter((c) => c.length > 0);
}

// -------------------------------------------------------------------
// MULTI-QUERY SEARCH - Generate multiple search queries
// -------------------------------------------------------------------
function getSearchQueries(title) {
  const queries = new Set();
  const aliasTitle = applyAlias(title);
  const normTitle = normalizeTitle(aliasTitle);
  const cleanTitle = removeStopWords(normTitle);

  if (title) queries.add(title.trim());
  if (aliasTitle && aliasTitle !== title) queries.add(aliasTitle);
  if (normTitle && normTitle !== title) queries.add(normTitle);
  if (cleanTitle && cleanTitle !== title && cleanTitle !== normTitle) queries.add(cleanTitle);

  // First 4 words, first 3 words (for long titles)
  const words = normTitle.split(/\s+/).filter((w) => w.length > 0);
  if (words.length >= 5) queries.add(words.slice(0, 4).join(" "));
  if (words.length >= 4) queries.add(words.slice(0, 3).join(" "));

  return Array.from(queries).filter((q) => q.length >= 3);
}

// ===================================================================
// ANIKOTO - Eng Sub + Eng Dub
// ===================================================================
async function getAnikotoLinks(title, episode) {
  const servers = [];

  for (const type of ["sub", "dub"]) {
    try {
      const searchUrl = `${ANIKOTO_API}/api/search?q=${encodeURIComponent(title)}`;
      const searchData = await fetchJSON(searchUrl);

      if (!searchData?.success || !searchData.data?.results?.length) continue;

      const targetSlug = searchData.data.results[0].slug;
      const episodeUrl = `${ANIKOTO_API}/api/episode/${targetSlug}/${episode}`;
      const episodeData = await fetchJSON(episodeUrl);

      if (!episodeData?.success || !episodeData.data?.servers) continue;

      for (const server of episodeData.data.servers) {
        if (server.type !== type) continue;

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
          type: type,
          language: "english",
          embed_url: embedUrl,
          ready_to_use: true,
        });
      }
    } catch (e) {}
  }

  return servers;
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
    const data = await fetchJSON(apiUrl);
    if (data?.success && data.data?.servers?.length > 0) {
      return data.data.servers;
    }
  } catch (e) {}
  return [];
}

// ToonStream Search API with similarity scoring
async function searchToonStreamSlugs(title) {
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

    const titleClean = removeStopWords(normalizeTitle(title));
    const scored = [];

    for (const item of json.data) {
      const itemUrl = item.url || "";
      const itemTitle = (item.title || "").trim();
      const match = itemUrl.match(/\/(?:series|movies|episode)\/([^\/\?]+)/);
      if (!match || !match[1]) continue;

      const itemTitleClean = removeStopWords(itemTitle);

      // Multi-signal similarity
      const score1 = similarityScore(title, itemTitle);
      const score2 = similarityScore(titleClean, itemTitleClean);
      const score = Math.max(score1, score2);

      // Series bonus
      const finalScore = score + (item.type === "series" ? 3 : 0);

      scored.push({
        slug: match[1],
        title: itemTitle,
        score: finalScore,
      });
    }

    // Filter by confidence threshold
    const filtered = scored.filter((s) => s.score >= MIN_MATCH_SCORE);
    filtered.sort((a, b) => b.score - a.score);

    // Deduplicate
    const seen = new Set();
    const unique = [];
    for (const item of filtered) {
      if (!seen.has(item.slug)) {
        seen.add(item.slug);
        unique.push(item.slug);
      }
    }
    return unique;
  } catch (e) {
    return [];
  }
}

// Build servers with filter + auto-numbering
function buildToonStreamServers(rawServers) {
  const workingUrls = [];
  for (const server of rawServers) {
    const originalUrl = server.embed_url;
    if (!originalUrl) continue;

    const isWorking = WORKING_TOONSTREAM_SERVERS.some((domain) =>
      originalUrl.includes(domain)
    );
    if (!isWorking) continue;
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
// TOONSTREAM - Multi-Strategy Fallback (v5.1 core)
// ===================================================================
async function getToonStreamLinks(slug, season, episode, title) {
  const triedSlugs = new Set();

  // ========== Strategy 1: Direct slug candidates ==========
  const slugCandidates = getSlugCandidates(slug, title);
  for (const candidate of slugCandidates) {
    if (triedSlugs.has(candidate)) continue;
    triedSlugs.add(candidate);

    const raw = await fetchToonStreamServers(candidate, season, episode);
    const built = buildToonStreamServers(raw);
    if (built.length > 0) return built;
  }

  // ========== Strategy 2: Multi-Query Search ==========
  const searchQueries = getSearchQueries(title);
  for (const query of searchQueries) {
    const searchSlugs = await searchToonStreamSlugs(query);
    for (const s of searchSlugs) {
      if (triedSlugs.has(s)) continue;
      triedSlugs.add(s);
      const raw = await fetchToonStreamServers(s, season, episode);
      const built = buildToonStreamServers(raw);
      if (built.length > 0) return built;
    }
  }

  // ========== Strategy 3: Progressive Word-Trim with Score Check ==========
  if (title) {
    const normTitle = normalizeTitle(applyAlias(title));
    const words = normTitle.split(/\s+/).filter((w) => w.length > 0);
    for (let i = words.length - 1; i >= 2; i--) {
      const shortTitle = words.slice(0, i).join(" ");
      if (searchQueries.includes(shortTitle)) continue;

      // Only accept if short title has good similarity
      if (similarityScore(title, shortTitle) < 60) continue;

      const searchSlugs = await searchToonStreamSlugs(shortTitle);
      for (const s of searchSlugs) {
        if (triedSlugs.has(s)) continue;
        triedSlugs.add(s);
        const raw = await fetchToonStreamServers(s, season, episode);
        const built = buildToonStreamServers(raw);
        if (built.length > 0) return built;
      }
    }
  }

  return [];
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
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    headers.set("Accept-Language", "en-US,en;q=0.9");
    headers.set("Referer", targetURL.origin + "/");

    const response = await fetch(targetUrl, { headers, redirect: "follow" });
    const newHeaders = new Headers(response.headers);
    newHeaders.delete("X-Frame-Options");
    newHeaders.delete("Content-Security-Policy");
    newHeaders.delete("Content-Security-Policy-Report-Only");
    newHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, { status: response.status, headers: newHeaders });
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

  const searchTitle = titleRomaji || titleEnglish || slug.replace(/-/g, " ");

  const [anikotoServers, toonstreamServers] = await Promise.all([
    getAnikotoLinks(searchTitle, episode),
    slug
      ? getToonStreamLinks(slug, season, episode, searchTitle)
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
      total_servers: allServers.length,
      sub_count: subServers.length,
      dub_count: dubServers.length,
      servers: allServers,
    },
  });
          }
