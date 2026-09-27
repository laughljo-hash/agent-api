// extract.mjs — fetch a URL and return { title, text } with basic readability
// cleaning. Dependency-free: no cheerio/jsdom, just careful regexes.

export class ExtractionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000; // 2 MB cap on downloaded pages

// --- SSRF guard: refuse hosts that resolve to this machine / private nets ---
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "0.0.0.0", "::1"].includes(h)) return true;
  if (/^127\./.test(h)) return true; // 127.0.0.0/8
  if (/^10\./.test(h)) return true; // 10.0.0.0/8
  if (/^192\.168\./.test(h)) return true; // 192.168.0.0/16
  if (/^169\.254\./.test(h)) return true; // link-local
  const m = h.match(/^172\.(\d+)\./); // 172.16.0.0/12
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^0\./.test(h)) return true;
  return false;
}

// --- minimal HTML entity decoder (no deps) ---
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      const c = parseInt(n, 16);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–");
}

const PAYWALL_HINTS = [
  /subscribe to (continue|keep reading|read)/i,
  /sign in to (read|continue)/i,
  /log in to (read|continue)/i,
  /you('ve| have) reached your (free )?article limit/i,
  /metered paywall/i,
  /this is premium content/i,
  /join (us|now) to (read|continue)/i,
];

function cleanHtml(html, rawLength) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || null
    : null;

  let body = html;
  body = body.replace(/<script[\s\S]*?<\/script\s*>/gi, " ");
  body = body.replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
  body = body.replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ");
  body = body.replace(/<svg[\s\S]*?<\/svg\s*>/gi, " ");
  body = body.replace(/<!--[\s\S]*?-->/g, " ");
  // Drop common boilerplate containers (nav / footer / asides)
  body = body.replace(/<(nav|footer|aside)[\s>][\s\S]*?<\/\1\s*>/gi, " ");
  // Block-level tags become line breaks
  body = body.replace(
    /<\/?(p|div|br|h[1-6]|li|tr|td|section|article|blockquote|pre|figure)[^>]*>/gi,
    "\n"
  );
  // Strip whatever tags remain
  body = body.replace(/<[^>]+>/g, " ");

  let text = decodeEntities(body);
  text = text.replace(/[ \t\u00a0\u2000-\u200b]+/g, " ");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 1)
    .join("\n")
    .trim();

  const paywallSuspected =
    PAYWALL_HINTS.some((re) => re.test(text)) ||
    (text.length < 400 && rawLength > 30_000);

  return { title, text, paywallSuspected };
}

export async function extractUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ExtractionError(400, `"${rawUrl}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractionError(
      400,
      "Only http:// and https:// URLs are supported."
    );
  }
  if (isBlockedHost(url.hostname)) {
    throw new ExtractionError(
      400,
      "That host is not allowed (local/private addresses are blocked)."
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "agent-api/1.0 (URL text extractor; contact via x402 payment)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    throw new ExtractionError(
      502,
      err.name === "AbortError"
        ? `Timed out fetching the URL after ${FETCH_TIMEOUT_MS / 1000}s.`
        : `Could not fetch the URL (${err.message}).`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ExtractionError(
      502,
      `The page returned HTTP ${res.status} ${res.statusText || ""}`.trim() + "."
    );
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new ExtractionError(413, "Page is too large to extract (over 2 MB).");
  }

  let raw;
  try {
    raw = await res.text();
  } catch {
    throw new ExtractionError(502, "Failed while downloading the page.");
  }
  if (raw.length > MAX_BYTES) raw = raw.slice(0, MAX_BYTES);

  // Non-HTML text (plain text, JSON, XML): return as-is, no title.
  if (!contentType.includes("html") && !contentType.includes("xml")) {
    if (contentType.includes("text/") || contentType.includes("json")) {
      const text = raw.trim();
      return {
        title: null,
        text,
        chars: text.length,
        finalUrl: res.url,
        paywallSuspected: false,
      };
    }
    throw new ExtractionError(
      415,
      `Unsupported content type: ${contentType || "unknown"}.`
    );
  }

  const { title, text, paywallSuspected } = cleanHtml(htmlSafe(raw), raw.length);
  if (!text) {
    throw new ExtractionError(
      502,
      "The page had no readable text (it may be JavaScript-rendered or a paywall)."
    );
  }
  return {
    title,
    text,
    chars: text.length,
    finalUrl: res.url,
    paywallSuspected,
  };
}

// Guard against absurdly malformed input blowing up the regexes.
function htmlSafe(s) {
  return s.length > MAX_BYTES ? s.slice(0, MAX_BYTES) : s;
}
