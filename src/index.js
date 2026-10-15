// ===================================================================
// src/index.js - Proxy API Worker (Industrial Level v5.0)
// ===================================================================
// Features:
//   • Anikoto      → Eng Sub + Eng Dub
//   • ToonStream   → Multi Audio (8 working servers)
//   • Auto Slug/Title Normalization (Season/Part/Cour/Final stripped)
//   • Multi-Strategy Fallback (5 layers of fallback)
//   • Auto-Numbering for duplicate servers
//   • Parallel Fetching + CORS
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
      version: "5.0-industrial",
      sources: ["anikoto", "toonstream"],
      working_servers: WORKING_TOONSTREAM_SERVERS.length,
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
// SLUG NORMALIZATION - Season/Part/Cour/Final-Season ইত্যাদি বাদ দেয়
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
// TITLE NORMALIZATION - একই কাজ টাইটেলের জন্য
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
// SLUG CANDIDATES - Multiple variations to try
// -------------------------------------------------------------------
function getSlugCandidates(slug, title) {
  const candidates = new Set();
  const normSlug = normalizeSlug(slug);
  const normTitle = normalizeTitle(title);

  // 1. Original slug
  if (slug) candidates.add(slug);

  // 2. Normalized slug
  if (normSlug && normSlug !== slug) candidates.add(normSlug);

  // 3. Title-based slug (normalized)
  if (normTitle) {
    const titleSlug = normTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (titleSlug) candidates.add(titleSlug);
  }

  // 4. Original title-based slug
  if (title) {
    const rawTitleSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (rawTitleSlug) candidates.add(rawTitleSlug);
  }

  return Array.from(candidates);
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

// ToonStream Search API - returns slugs sorted by title-match score
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

    const titleLower = title.toLowerCase().trim();
    const scored = [];

    for (const item of json.data) {
      const itemUrl = item.url || "";
      const itemTitle = (item.title || "").toLowerCase().trim();
      const match = itemUrl.match(/\/(?:series|movies|episode)\/([^\/\?]+)/);
      if (!match || !match[1]) continue;

      let score = 30;
      if (itemTitle === titleLower) score = 100;
      else if (itemTitle.startsWith(titleLower)) score = 90;
      else if (itemTitle.includes(titleLower)) score = 80;
      else if (titleLower.includes(itemTitle)) score = 70;

      if (item.type === "series") score += 5;

      scored.push({ slug: match[1], title: itemTitle, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = [];
    for (const item of scored) {
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

// Filter + auto-numbering
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
// TOONSTREAM - Multi-Strategy Fallback (v5.0 core logic)
// ===================================================================
async function getToonStreamLinks(slug, season, episode, title) {
  const triedSlugs = new Set();

  // ========== Strategy 1: Slug Candidates (Original + Normalized + Title-based) ==========
  const slugCandidates = getSlugCandidates(slug, title);
  for (const candidate of slugCandidates) {
    if (triedSlugs.has(candidate)) continue;
    triedSlugs.add(candidate);

    const raw = await fetchToonStreamServers(candidate, season, episode);
    const built = buildToonStreamServers(raw);
    if (built.length > 0) return built;
  }

  // ========== Strategy 2: Search with Original Title ==========
  if (title) {
    const searchSlugs1 = await searchToonStreamSlugs(title);
    for (const s of searchSlugs1) {
      if (triedSlugs.has(s)) continue;
      triedSlugs.add(s);
      const raw = await fetchToonStreamServers(s, season, episode);
      const built = buildToonStreamServers(raw);
      if (built.length > 0) return built;
    }
  }

  // ========== Strategy 3: Search with Normalized Title ==========
  const normTitle = normalizeTitle(title || "");
  if (normTitle && normTitle !== title) {
    const searchSlugs2 = await searchToonStreamSlugs(normTitle);
    for (const s of searchSlugs2) {
      if (triedSlugs.has(s)) continue;
      triedSlugs.add(s);
      const raw = await fetchToonStreamServers(s, season, episode);
      const built = buildToonStreamServers(raw);
      if (built.length > 0) return built;
    }
  }

  // ========== Strategy 4: Progressive Word-Trim Fallback ==========
  if (title) {
    const words = title.trim().split(/\s+/);
    for (let i = words.length - 1; i >= 2; i--) {
      const shortTitle = words.slice(0, i).join(" ");
      if (shortTitle === title || shortTitle === normTitle) continue;

      const searchSlugs3 = await searchToonStreamSlugs(shortTitle);
      for (const s of searchSlugs3) {
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
