// src/index.js - Proxy API Worker (Final Version)
// Anikoto: Sub + Dub | ToonStream: Hindi Dub

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
      endpoints: {
        streaming: "/api/streaming?slug=...&title=...&season=...&episode=...",
        proxy: "/proxy?url=ENCODED_URL",
      },
    });
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ============ ANIKOTO (Sub + Dub) ============
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
          embed_url: embedUrl,
          ready_to_use: true,
        });
      }
    } catch (e) {}
  }

  return servers;
}

// ============ TOONSTREAM (Hindi Dub Only) ============
function getToonStreamServerName(url) {
  if (url.includes("voe.sx")) return "VOE";
  if (url.includes("vidara.to")) return "Vidara";
  if (url.includes("vidc.upns.pro")) return "Vidc";
  if (url.includes("abyssplayer.com")) return "Abyss";
  if (url.includes("filesforever.link")) return "FilesForever";
  return "Unknown";
}

async function getToonStreamLinks(slug, season, episode) {
  const servers = [];
  try {
    const apiUrl = `${TOONSTREAM_API}/api/streaming?slug=${encodeURIComponent(slug)}&season=${season}&episode=${episode}`;
    const data = await fetchJSON(apiUrl);

    if (!data?.success || !data.data?.servers) return servers;

    for (const server of data.data.servers) {
      const originalUrl = server.embed_url;
      if (!originalUrl) continue;

      const isWorking = WORKING_TOONSTREAM_SERVERS.some((domain) =>
        originalUrl.includes(domain)
      );
      if (!isWorking) continue;

      servers.push({
        server_name: `ToonStream - ${getToonStreamServerName(originalUrl)}`,
        source: "toonstream",
        type: "dub",
        language: "hindi",
        embed_url: originalUrl,
        ready_to_use: true,
      });
    }
  } catch (e) {}
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
    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
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

  const [anikotoServers, toonstreamServers] = await Promise.all([
    getAnikotoLinks(searchTitle, episode),
    slug ? getToonStreamLinks(slug, season, episode) : Promise.resolve([]),
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
