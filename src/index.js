// ===================================================================
// src/index.js - Proxy API Worker (Industrial Level v4.0)
// ===================================================================
// Features:
//   • Anikoto      → Eng Sub + Eng Dub (/videojs/ auto-inject)
//   • ToonStream   → Multi Audio (8 working servers)
//   • Auto-Numbering for duplicate servers (FilesForever 1, 2, 3...)
//   • Multi-Slug Search Fallback (tries ALL matches, not just first)
//   • Title Match Scoring (best slug wins)
//   • Parallel Fetching (Anikoto + ToonStream simultaneously)
//   • CORS enabled for cross-account Workers
// ===================================================================

const ANIKOTO_API = "https://anikoto-api-bl5m.onrender.com";
const TOONSTREAM_API = "https://toonstream-scraper-5mws.onrender.com";
const TOONSTREAM_SITE = "https://toonstream.us";

// ToonStream servers that work directly inside <iframe> without proxy
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
      version: "4.0-industrial",
      endpoints: {
        streaming: "/api/streaming?slug=...&title=...&season=...&episode=...",
        proxy: "/proxy?url=ENCODED_URL",
      },
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

        // Inject /videojs/ for megaplay.buzz
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
    } catch (e) {
      // Silent fail — try next type
    }
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

// Fetch raw servers from ToonStream Scraper API
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

// Search ToonStream → returns array of slugs sorted by title match score
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

      // Title match scoring
      let score = 30;
      if (itemTitle === titleLower) score = 100;
      else if (itemTitle.startsWith(titleLower)) score = 90;
      else if (itemTitle.includes(titleLower)) score = 80;
      else if (titleLower.includes(itemTitle)) score = 70;

      // Bonus for matching type (series vs movie)
      if (item.type === "series") score += 5;

      scored.push({ slug: match[1], title: itemTitle, score });
    }

    // Sort by score DESC, then deduplicate
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

// Filter + auto-numbering for ToonStream servers
function buildToonStreamServers(rawServers) {
  // Step 1: Filter only working servers
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

  // Step 2: Count domains
  const domainCounts = {};
  for (const url of workingUrls) {
    const baseName = getToonStreamServerName(url);
    domainCounts[baseName] = (domainCounts[baseName] || 0) + 1;
  }

  // Step 3: Add numbering when duplicates exist
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
// TOONSTREAM - Multi Audio with Multi-Slug Fallback
// ===================================================================
async function getToonStreamLinks(slug, season, episode, title) {
  // Step 1: Try direct slug
  let rawServers = await fetchToonStreamServers(slug, season, episode);
  let servers = buildToonStreamServers(rawServers);
  if (servers.length > 0) return servers;

  // Step 2: Search fallback — try ALL matching slugs until one works
  if (title) {
    const candidateSlugs = await searchToonStreamSlugs(title);
    for (const candidate of candidateSlugs) {
      if (candidate === slug) continue; // already tried
      rawServers = await fetchToonStreamServers(candidate, season, episode);
      servers = buildToonStreamServers(rawServers);
      if (servers.length > 0) return servers;
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

  const searchTitle = titleRomaji || titleEnglish || slug.replace(/-/g, " ");

  // Parallel fetch: Anikoto + ToonStream simultaneously
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
