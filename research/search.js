// Aura AI — research/search.js
// Real web-access layer for the Deep Research engine. Two capabilities:
//
//   1. searchWeb()  — web search via Gemini's google_search grounding
//                     tool. This reuses the server's existing
//                     GEMINI_API_KEY (no separate search-provider key) and
//                     returns REAL grounded source URLs from
//                     groundingMetadata — never invented links. If the
//                     provider returns no grounding chunks, we return an
//                     empty source list rather than fabricating results.
//   2. fetchPageText() — opens and reads a real web page (SSRF-guarded,
//                     size-capped, time-boxed), extracting readable text.
//
// Plus classifySource(): deterministic domain-based source tiering
// (Tier 1 government/academic/official, Tier 2 established press/research
// orgs, Tier 3 everything else) used by the engine's source-quality
// ranking.

const dns = require('dns').promises;
const net = require('net');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const PAGE_TIMEOUT_MS = 15_000;
const PAGE_MAX_BYTES = 3 * 1024 * 1024;   // read at most 3MB of any page
const TEXT_MAX_CHARS = 60_000;            // keep at most 60k chars of text
const MAX_REDIRECTS = 3;
const FETCH_CONCURRENCY = 4;

const CACHE_TTL_MS = 30 * 60 * 1000;      // 30 minutes
const CACHE_MAX_ENTRIES = 120;

// ---- simple LRU-ish cache shared by search + page fetch (cost control) ----
const cache = new Map(); // key -> { at, value }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  // refresh recency
  cache.delete(key); cache.set(key, hit);
  return hit.value;
}
function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value); // evict oldest inserted
  }
  cache.set(key, { at: Date.now(), value });
}

// ---- concurrency limiter for page fetches ----
let activeFetches = 0;
const fetchQueue = [];
function acquireFetchSlot() {
  return new Promise((resolve) => {
    if (activeFetches < FETCH_CONCURRENCY) { activeFetches++; resolve(); return; }
    fetchQueue.push(resolve);
  });
}
function releaseFetchSlot() {
  const next = fetchQueue.shift();
  if (next) next();
  else activeFetches--;
}

// ============================================================
// SOURCE TIERING (deterministic, domain-based)
// ============================================================
const TIER1_DOMAIN_RE = /\.(gov|edu|mil|int)(\/|$|\.)|\.gov\.|\.edu\.|\.ac\./i;
const TIER1_EXACT = new Set([
  'europa.eu', 'who.int', 'un.org', 'oecd.org', 'imf.org', 'worldbank.org',
  'nist.gov', 'fda.gov', 'sec.gov', 'congress.gov', 'europarl.europa.eu',
  'whitehouse.gov', 'gov.uk', 'isc.gov.in', 'meity.gov.in', 'cac.gov.cn',
  'arxiv.org', 'nature.com', 'science.org', 'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov', 'plos.org', 'ieee.org', 'acm.org', 'springer.com',
  'sciencedirect.com', 'dl.acm.org', 'bmj.com', 'thelancet.com',
  'copyright.gov', 'iso.org', 'w3.org', 'ietf.org', 'iana.org',
]);
const TIER2_EXACT = new Set([
  'reuters.com', 'apnews.com', 'bloomberg.com', 'ft.com', 'wsj.com',
  'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'bbc.com',
  'bbc.co.uk', 'economist.com', 'cnbc.com', 'cnn.com', 'npr.org',
  'politico.com', 'axios.com', 'techcrunch.com', 'theverge.com',
  'wired.com', 'arstechnica.com', 'technologyreview.com', 'ieee.org',
  'mckinsey.com', 'bcg.com', 'bain.com', 'deloitte.com', 'pwc.com',
  'gartner.com', 'idc.com', 'statista.com', 'ourworldindata.org',
  'brookings.edu', 'rand.org', 'csis.org', 'pewresearch.org',
  'brookings.com', 'kff.org', 'commonwealthfund.org',
]);
const AGGREGATOR_RE = /reddit\.com|quora\.com|medium\.com|substack\.com|facebook\.com|x\.com|twitter\.com|instagram\.com|tiktok\.com|pinterest\.com|answers\.com|yahoo\.com\/answers|stackexchange\.com|stackoverflow\.com|wikipedia\.org|britannica\.com|youtube\.com/i;

// Exact-or-subdomain membership: "europa.eu" matches "europa.eu" and
// "eur-lex.europa.eu" alike.
function matchesDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

// Returns { tier: 1|2|3, kind } — kind is a human label used on source cards.
function classifySource(rawUrl) {
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return { tier: 3, kind: 'Web' }; }

  const t1 = [...TIER1_EXACT].some(d => matchesDomain(host, d));
  const t2 = [...TIER2_EXACT].some(d => matchesDomain(host, d));
  if (t1 || TIER1_DOMAIN_RE.test(host)) {
    if (/arxiv|nature|science|pubmed|ncbi|plos|ieee|acm|springer|sciencedirect|bmj|lancet/.test(host)) {
      return { tier: 1, kind: 'Scientific Publication' };
    }
    if (/europa|un\.org|who\.int|oecd|imf|worldbank|nist|sec\.gov|congress|gov\.uk|gov\.in|gov\.cn|gov$/.test(host)) {
      return { tier: 1, kind: 'Government / Official' };
    }
    return { tier: 1, kind: 'Primary / Official' };
  }
  if (t2) {
    if (/mckinsey|bcg|bain|deloitte|pwc|gartner|idc|statista/.test(host)) return { tier: 2, kind: 'Industry Research' };
    if (/brookings|rand|csis|pewresearch|kff|commonwealth/.test(host)) return { tier: 2, kind: 'Research Organization' };
    return { tier: 2, kind: 'Established Journalism' };
  }
  if (AGGREGATOR_RE.test(host)) return { tier: 3, kind: 'Aggregator / Community' };
  return { tier: 3, kind: 'Web' };
}

function domainOf(rawUrl) {
  try { return new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ============================================================
// V2 — CANONICAL URL DEDUPLICATION
// Same article syndicated/mirrored/parameterized differently collapses
// to one canonical key so evidence independence is counted honestly.
// ============================================================
function canonicalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.protocol = 'https:';
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    // Strip known tracking/display params; keep meaningful ones (ids, pages).
    const TRACKING = /^utm_|^(fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|cmp|spm|igshid|si)$/i;
    const keys = [...u.searchParams.keys()];
    for (const k of keys) if (TRACKING.test(k)) u.searchParams.delete(k);
    // Sort remaining params so ?b=2&a=1 === ?a=1&b=2
    const remaining = [...u.searchParams.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    // Normalize the path BEFORE appending params so '/p/' + '?a=1' and
    // '/p' + '?a=1' collapse to the same key.
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    u.search = '';
    for (const [k, v] of remaining) u.searchParams.append(k, v);
    return u.toString();
  } catch { return String(rawUrl || '').toLowerCase(); }
}

// Near-duplicate detection for syndicated content: same registrable domain
// is NOT a dup, but same title (normalized) anywhere is.
function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).slice(0, 12).join(' ');
}

// ============================================================
// V2 — SEARCH PROVIDER ABSTRACTION
// One physical backend (Gemini google_search grounding) is shaped into
// logical providers via query steering + result filtering, so additional
// physical providers (a dedicated news API, an academic API…) can slot in
// later behind the same interface. Providers:
//   general  — open web
//   academic — scholarly/scientific (arxiv, journals, .edu, pubmed)
//   government — official/regulatory (.gov, europa.eu, intl orgs)
//   news     — recent reporting (established outlets)
//   company  — first-party/official documentation
// ============================================================
const PROVIDERS = {
  general: {
    label: 'General Web',
    steer: null,
    prefer: null,
  },
  academic: {
    label: 'Academic',
    // Steering is prompt-level (grounding obeys it better than site: operators)
    steer: 'Prioritize scholarly and scientific sources: peer-reviewed papers, arxiv preprints, journal articles, university research, and scientific datasets.',
    prefer: /arxiv\.org|scholar\.|pubmed|ncbi|nature\.com|science\.org|sciencedirect|springer|ieee|acm\.org|dl\.acm|plos|\.edu|jstor|ssrn|biorxiv|semanticscholar/i,
  },
  government: {
    label: 'Government / Official',
    steer: 'Prioritize primary official sources: government sites, regulators, legislation, treaties, official statistics, and international organizations.',
    prefer: /\.gov(\.|\/)|\.gov$|europa\.eu|un\.org|who\.int|oecd\.org|imf\.org|worldbank\.org|gov\.uk|gov\.in|gov\.cn|europarl|nist\.gov|sec\.gov| congress\.gov|isc\.org/i,
  },
  news: {
    label: 'News / Current',
    steer: 'Prioritize recent reporting from established news organizations, published in the last 12 months where possible.',
    prefer: /reuters|apnews|bloomberg|ft\.com|wsj\.com|nytimes|washingtonpost|theguardian|bbc\.|economist|cnbc|politico|axios|npr\.org/i,
  },
  company: {
    label: 'Company / Official Docs',
    steer: 'Prioritize first-party sources: official company documentation, product pages, press releases, investor relations, and official technical blogs.',
    prefer: null, // first-party detection is per-query (match result domain to entity tokens), kept simple: rely on steering
  },
};

function providerDefinition(name) {
  return PROVIDERS[name] || PROVIDERS.general;
}

// ============================================================
// V2 — CONTEXT-AWARE RECENCY
// Current topics strongly reward freshness; historical topics prefer
// authority; scientific topics blend newest + foundational. encode as a
// small weighting profile rather than a hard filter.
// ============================================================
const RECENCY_PROFILES = {
  current:    { within1y: 1.0, within3y: 0.6, older: 0.15 },
  historical: { within1y: 0.2, within3y: 0.35, older: 0.9 },
  scientific: { within1y: 0.9, within3y: 0.7, older: 0.5 },
  evergreen:  { within1y: 0.5, within3y: 0.5, older: 0.5 },
};

function recencyWeight(profile, dateHint) {
  if (!dateHint) return 0.35; // unknown age: neutral-ish
  const p = RECENCY_PROFILES[profile] || RECENCY_PROFILES.evergreen;
  const years = (Date.now() - new Date(dateHint).getTime()) / (365.25 * 24 * 3600 * 1000);
  if (Number.isNaN(years)) return 0.35;
  if (years <= 1) return p.within1y;
  if (years <= 3) return p.within3y;
  return p.older;
}

// ============================================================
// WEB SEARCH — Gemini google_search grounding
// ============================================================
class SearchError extends Error {
  constructor(message, { httpStatus = null, code = 'SEARCH_FAILED' } = {}) {
    super(message);
    this.name = 'SearchError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

// Searches the real web via Gemini grounding. Returns:
//   { answer: string, sources: [{url, title}], queries: string[] }
// `sources` comes ONLY from the provider's groundingMetadata chunks — real
// URLs the search actually grounded on. Empty array when the provider
// returned nothing grounded (the engine treats that as a failed search,
// never invents results).
// V2: `provider` (general|academic|government|news|company) steers the
// search and boosts matching results in the returned order.
async function searchWeb({ apiKey, geminiModel, query, context, provider = 'general' }) {
  const def = providerDefinition(provider);
  const steeredQuery = def.steer ? `${query}\n\n(${def.steer})` : query;
  const cacheKey = `search:${geminiModel}:${provider}:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let res, data;
  try {
    res = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(geminiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: `You are a web research assistant working the ${def.label} beat. Search the web and answer the given research question concisely with specific facts, numbers, names and dates. Write the answer as compact prose or brief bullets. Only state what the search results support.${def.steer ? ' ' + def.steer : ''}`,
          }],
        },
        contents: [{
          role: 'user',
          parts: [{ text: context ? `${steeredQuery}\n\nResearch context: ${context}` : steeredQuery }],
        }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1600 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    data = await res.json();
  } catch (err) {
    throw new SearchError(`Search network error: ${err.message}`, { code: 'SEARCH_NETWORK_ERROR' });
  }

  if (!res.ok) {
    const providerCode = data?.error?.status || null;
    // Grounding quota is a separate bucket from generation quota — a free/
    // low-tier key can generate fine but hard-fail every grounded search.
    // Rather than sinking the whole research run, fall back to the keyless
    // DuckDuckGo HTML provider (below) so discovery still works. The result
    // is tagged with the provider that served it — nothing is disguised.
    const quotaExhausted = res.status === 429 || String(providerCode).includes('RESOURCE_EXHAUSTED');
    if (quotaExhausted) {
      const ddg = await ddgSearch(query);
      if (ddg.sources.length > 0) {
        cacheSet(cacheKey, ddg);
        return ddg;
      }
    }
    throw new SearchError(data?.error?.message || 'Search request failed.', {
      httpStatus: res.status,
      code: providerCode || 'SEARCH_HTTP_ERROR',
    });
  }

  const candidate = data?.candidates?.[0] || null;
  const answer = candidate?.content?.parts?.map(p => p.text || '').join('').trim() || '';

  // Grounded URLs — the only trustworthy source of real links here.
  const seen = new Map();
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  for (const chunk of chunks) {
    const web = chunk?.web;
    if (web && typeof web.uri === 'string' && /^https?:\/\//i.test(web.uri)) {
      const normalized = web.uri.split('#')[0];
      if (!seen.has(normalized)) seen.set(normalized, { url: normalized, title: (web.title || '').trim() || normalized });
    }
  }
  const queries = (candidate?.groundingMetadata?.webSearchQueries || []).filter(q => typeof q === 'string');

  // Provider boost: re-order grounded chunks so preferred domains lead.
  let sources = [...seen.values()];
  if (def.prefer) {
    sources.sort((a, b) => (def.prefer.test(b.url) ? 1 : 0) - (def.prefer.test(a.url) ? 1 : 0));
  }

  const result = { answer, sources, queries, provider };
  cacheSet(cacheKey, result);
  return result;
}

// ============================================================
// KEYLESS FALLBACK SEARCH — DuckDuckGo HTML endpoint
// Used when Gemini google_search grounding is quota-blocked (free-tier
// keys). Returns the same { answer, sources, queries, provider } shape;
// sources are real result URLs (DDG redirect links unwrapped), the answer
// is the concatenated result snippets — labeled as such, never presented
// as a model synthesis. Politeness: browser UA, 1.2s min interval between
// hits, and the shared 30-min query cache dedupes repeats.
// ============================================================
let ddgLastCall = 0;
let ddgBackoffMs = 0; // grows when DDG throttles (202/anomaly), decays on success
const DDG_MIN_INTERVAL_MS = 1200;
const DDG_MAX_BACKOFF_MS = 30_000;

async function ddgSearch(query) {
  // Politeness pacing + throttle backoff (verified live: DDG serves a 202
  // anomaly/captcha page when hammered; backing off recovers it).
  const interval = DDG_MIN_INTERVAL_MS + ddgBackoffMs;
  const wait = ddgLastCall + interval - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  ddgLastCall = Date.now();

  let res, html;
  try {
    res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en',
      },
      signal: AbortSignal.timeout(15_000),
    });
    html = await res.text();
  } catch (err) {
    return { answer: '', sources: [], queries: [query], provider: 'ddg-html', error: err.message };
  }
  // Anomaly/captcha page: throttled — back off and report a failed search
  // (the engine records it honestly and continues).
  const throttled = res.status === 202 || /anomaly|captcha|challenge/i.test(html);
  if (!res.ok || throttled) {
    ddgBackoffMs = Math.min(ddgBackoffMs > 0 ? ddgBackoffMs * 2 : 4000, DDG_MAX_BACKOFF_MS);
    return { answer: '', sources: [], queries: [query], provider: 'ddg-html', error: throttled ? `throttled (HTTP ${res.status})` : `HTTP ${res.status}` };
  }
  ddgBackoffMs = Math.max(0, Math.floor(ddgBackoffMs / 2));

  const unwrap = (href) => {
    try {
      if (href.startsWith('//')) href = 'https:' + href;
      const u = new URL(href);
      if (u.hostname.includes('duckduckgo.com') && u.searchParams.has('uddg')) {
        return u.searchParams.get('uddg');
      }
      return u.toString();
    } catch { return null; }
  };
  const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

  const seen = new Map();
  const snippets = [];
  for (const m of html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = unwrap(m[1].replace(/&amp;/g, '&'));
    const title = stripTags(m[2]);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (/duckduckgo\.com|\/y\.js/i.test(url)) continue; // ads/self links
    if (!seen.has(url)) {
      seen.set(url, { url, title: title || url });
      if (snippets.length < 5 && title) snippets.push(title);
    }
  }
  for (const m of html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)) {
    const snip = stripTags(m[1]);
    if (snip && snippets.length < 5 && !snippets.includes(snip)) snippets.push(snip);
  }

  return {
    answer: snippets.length ? `Search result snippets: ${snippets.slice(0, 4).join(' … ')}` : '',
    sources: [...seen.values()].slice(0, 10),
    queries: [query],
    provider: 'ddg-html',
  };
}

// ============================================================
// PAGE FETCH — open + read a real page (SSRF-guarded)
// ============================================================
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // IPv4-mapped (::ffff:10.0.0.1)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

// Blocks localhost/private/internal targets — this is the SSRF boundary for
// research page reading. Both the literal hostname and every DNS resolution
// are checked.
async function assertPublicHttpUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new SearchError('Invalid URL.', { code: 'BAD_URL' }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SearchError('Only http(s) URLs can be opened.', { code: 'BAD_URL' });
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SearchError('Internal addresses cannot be opened.', { code: 'BLOCKED_HOST' });
  }
  if (net.isIPv4(host) && isPrivateIPv4(host)) throw new SearchError('Internal addresses cannot be opened.', { code: 'BLOCKED_HOST' });
  if (net.isIPv6(host) && isPrivateIPv6(host)) throw new SearchError('Internal addresses cannot be opened.', { code: 'BLOCKED_HOST' });
  if (!net.isIP(host)) {
    let addrs;
    try { addrs = await dns.lookup(host, { all: true }); }
    catch { throw new SearchError('Host could not be resolved.', { code: 'DNS_FAILURE' }); }
    for (const { address, family } of addrs) {
      const bad = family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
      if (bad) throw new SearchError('Internal addresses cannot be opened.', { code: 'BLOCKED_HOST' });
    }
  }
  return url;
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”',
};
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|ndash|mdash|hellip|rsquo|lsquo|ldquo|rdquo);/g, (m) => ENTITIES[m] || m);
}

// Minimal, dependency-free HTML → readable text. Not a full browser, but
// good enough to extract the prose a research agent needs: strips
// script/style/noscript/svg/head noise, treats block tags + <br> as line
// breaks, decodes entities, collapses whitespace.
function htmlToText(html) {
  let title = '';
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) title = decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();

  let working = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|dd|dt)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  working = decodeEntities(working)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.trim()).join('\n')
    .trim();
  if (working.length > TEXT_MAX_CHARS) working = working.slice(0, TEXT_MAX_CHARS);
  return { title, text: working };
}

// Best-effort publication-date hint from URL or page metadata. Returns an
// ISO date string or null — used for source freshness, never fabricated.
function extractDateHint(url, rawHtml) {
  const urlMatch = /\/(19|20)\d{2}[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])/.exec(url);
  if (urlMatch) return urlMatch[0].slice(1);
  const meta = /<meta[^>]+(?:property|name)=["'](?:article:published_time|article:modified_time|og:updated_time|date)["'][^>]+content=["']([^"']+)["']/i.exec(rawHtml)
    || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|article:modified_time|og:updated_time|date)["']/i.exec(rawHtml);
  if (meta) {
    const d = new Date(meta[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const timeTag = /<time[^>]+datetime=["']([^"']+)["']/i.exec(rawHtml);
  if (timeTag) {
    const d = new Date(timeTag[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

// Opens a URL and extracts readable text. Redirects are followed manually
// (max 3) so every hop re-passes the SSRF guard. Returns:
//   { ok: true, url, finalUrl, title, text, dateHint, bytes }
//   { ok: false, url, error, code }
async function fetchPageText(rawUrl) {
  const cached = cacheGet(`page:${rawUrl}`);
  if (cached) return cached;

  let currentUrl = rawUrl;
  try {
    await assertPublicHttpUrl(currentUrl);
    await acquireFetchSlot();
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await fetch(currentUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AuraAI-Research/1.0; +https://aura.ai)',
            'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
            'Accept-Language': 'en',
          },
        });

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          if (!location) return fail(currentUrl, 'Redirect without target.', 'REDIRECT_LOOP');
          const next = new URL(location, currentUrl).toString(); // resolve relative
          try { await res.body?.cancel(); } catch { /* drain best-effort */ }
          currentUrl = next;
          await assertPublicHttpUrl(currentUrl);
          continue;
        }

        if (!res.ok) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          return fail(currentUrl, `HTTP ${res.status}`, 'HTTP_ERROR');
        }

        const contentType = res.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml|text\/plain|application\/json/i.test(contentType)) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          return fail(currentUrl, `Unsupported content-type: ${contentType || 'unknown'}`, 'UNSUPPORTED_CONTENT');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let raw = '';
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > PAGE_MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();

        const isPlain = /^text\/plain/i.test(contentType);
        const { title, text } = isPlain
          ? { title: '', text: decodeEntities(raw).replace(/\n{3,}/g, '\n\n').trim().slice(0, TEXT_MAX_CHARS) }
          : htmlToText(raw);

        if (text.length < 200) return fail(currentUrl, 'Page had no readable text.', 'EMPTY_PAGE');

        const result = {
          ok: true, url: rawUrl, finalUrl: currentUrl,
          title, text, dateHint: extractDateHint(currentUrl, raw), bytes: total,
        };
        cacheSet(`page:${rawUrl}`, result);
        return result;
      }
      return fail(currentUrl, 'Too many redirects.', 'REDIRECT_LOOP');
    } finally {
      releaseFetchSlot();
    }
  } catch (err) {
    if (err instanceof SearchError) return fail(rawUrl, err.message, err.code);
    return fail(rawUrl, err.name === 'TimeoutError' ? 'Timed out.' : err.message, 'FETCH_ERROR');
  }

  function fail(url, error, code) {
    return { ok: false, url, error, code };
  }
}

// Relevance score used to rank candidate sources for a question: tier
// weight + query-word overlap with title/URL + context-aware recency
// (V2: `recencyProfile` picks the weighting — 'current' rewards fresh
// sources, 'historical' rewards established ones, etc.).
function scoreCandidate(source, query, dateHint, recencyProfile = 'evergreen') {
  const { tier } = classifySource(source.url);
  const tierScore = tier === 1 ? 3 : tier === 2 ? 2 : 1;
  const qWords = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
  const hay = `${source.title || ''} ${source.url}`.toLowerCase();
  let overlap = 0;
  for (const w of qWords) if (hay.includes(w)) overlap++;
  const relevance = qWords.size > 0 ? overlap / qWords.size : 0;
  const recency = recencyWeight(recencyProfile, dateHint);
  return tierScore + relevance * 2 + recency * 1.5;
}

module.exports = {
  SearchError,
  searchWeb,
  fetchPageText,
  classifySource,
  domainOf,
  scoreCandidate,
  htmlToText,
  canonicalUrl,
  normalizeTitle,
  PROVIDERS,
  providerDefinition,
  recencyWeight,
};
