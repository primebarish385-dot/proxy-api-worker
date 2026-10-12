// src/index.js - Proxy API Worker (Production Ready v2.0)
// Features: Anikoto (Eng Sub+Dub) | ToonStream (Multi Audio)
// Auto-Numbering | Search Fallback | Smart Filtering

const ANIKOTO_API = "https://anikoto-api-bl5m.onrender.com";
const TOONSTREAM_API = "https://toonstream-scraper-5mws.onrender.com";

// ToonStream: শুধু যেসব সার্ভার সরাসরি iframe-এ কাজ করে
const WORKING_TOONSTREAM_SERVERS = [
  "voe.sx",
  "vidara.to",
  "vidc.upns.pro",
  "abyssplayer.com",
  "filesforever.link",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
      version: "2.0",
      endpoints: {
        streaming: "/api/streaming?slug=...&title=...&season=...&episode=...",
        proxy: "/proxy?url=ENCODED_URL",
      },
    });
  },
};

// ============ UTILITIES ============
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

async function fetchJSON(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        ...extraHeaders,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ============ ANIKOTO (Eng Sub + Eng Dub) ============
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

        // /videojs/ ট্যাগ অ্যাপ্লাই
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

// ============ TOONSTREAM HELPERS ============
function getToonStreamServerName(url) {
  if (url.includes("voe.sx")) return "VOE";
  if (url.includes("vidara.to")) return "Vidara";
  if (url.includes("vidc.upns.pro")) return "Vidc";
  if (url.includes("abyssplayer.com")) return "Abyss";
  if (url.includes("filesforever.link")) return "FilesForever";
  return "Unknown";
}

// ToonStream Scraper থেকে সার্ভার আনা
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

// ToonStream সার্চ API দিয়ে সঠিক স্লাগ খোঁজা
async function searchToonStreamSlug(title) {
  try {
    const searchUrl = `https://toonstream.us/search/all?q=${encodeURIComponent(title)}`;
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        Referer: "https://toonstream.us/",
      },
    });
    if (!res.ok) return null;

    const json = await res.json();
    if (!Array.isArray(json.data) || json.data.length === 0) return null;

    // প্রথম রেজাল্ট থেকে স্লাগ এক্সট্রাক্ট
    for (const item of json.data) {
      const itemUrl = item.url || "";
      const match = itemUrl.match(/\/(?:series|movies|episode)\/([^\/\?]+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch (e) {}
  return null;
}

// ============ TOONSTREAM (Multi Audio + Search Fallback) ============
async function getToonStreamLinks(slug, season, episode, title) {
  const servers = [];

  // ধাপ ১: সরাসরি স্লাগ দিয়ে চেষ্টা
  let rawServers = await fetchToonStreamServers(slug, season, episode);

  // ধাপ ২: ব্যর্থ হলে Search API দিয়ে সঠিক স্লাগ খোঁজা
  if (rawServers.length === 0 && title) {
    const newSlug = await searchToonStreamSlug(title);
    if (newSlug && newSlug !== slug) {
      rawServers = await fetchToonStreamServers(newSlug, season, episode);
    }
  }

  if (rawServers.length === 0) return servers;

  // ধাপ ৩: শুধু working সার্ভার ফিল্টার
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

  // ধাপ ৪: প্রতিটি ডোমেইনের সংখ্যা গণনা
  const domainCounts = {};
  for (const url of workingUrls) {
    const baseName = getToonStreamServerName(url);
    domainCounts[baseName] = (domainCounts[baseName] || 0) + 1;
  }

  // ধাপ ৫: একই ডোমেইনের একাধিক থাকলে নাম্বার যোগ
  const domainIndexes = {};
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

// ============ PROXY HANDLER ============
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
    newHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  } catch (e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

// ============ MAIN STREAMING API ============
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

  // Parallel execution: Anikoto + ToonStream একসাথে
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
