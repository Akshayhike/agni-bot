/**
 * Web tools. web_search tries providers in order: Brave (if AGNI_BRAVE_API_KEY
 * set), Firecrawl (if AGNI_FIRECRAWL_API_KEY set), SearXNG (if configured),
 * then DuckDuckGo Instant Answer (zero-config fallback, limited to topics
 * with Wikipedia-style abstracts). web_fetch reuses fetchPage with SSRF
 * protections; Firecrawl is used for JS-rendered pages when configured.
 */
import { fetchPage } from "./fetch-url";

const SEARXNG_URL = process.env.AGNI_SEARXNG_URL?.trim();
const FIRECRAWL_KEY = process.env.AGNI_FIRECRAWL_API_KEY?.trim();
const BRAVE_KEY = process.env.AGNI_BRAVE_API_KEY?.trim();
const GOOGLE_CSE_KEY = process.env.AGNI_GOOGLE_CSE_API_KEY?.trim();
const GOOGLE_CSE_ID = process.env.AGNI_GOOGLE_CSE_ID?.trim();

export interface WebSearchArgs {
  query: string;
  count?: number;
}

export interface WebSearchResult {
  query: string;
  results: { title: string; url: string; snippet: string }[];
  provider: string;
}

/** Brave Search API: free tier 2,000 queries/month, no credit card. Recommended. */
async function searchBrave(query: string, count: number): Promise<WebSearchResult | null> {
  if (!BRAVE_KEY) return null;
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": BRAVE_KEY,
      },
    });
    if (!response.ok) return null;
    const payload = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    const results = (payload.web?.results ?? []).slice(0, count).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      snippet: entry.description ?? "",
    }));
    if (results.length === 0) return null;
    return { query, results, provider: "brave" };
  } catch {
    return null;
  }
}

/** Google Custom Search: free tier 100 queries/day. */
async function searchGoogleCSE(query: string, count: number): Promise<WebSearchResult | null> {
  if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_ID) return null;
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=${Math.min(count, 10)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const payload = await response.json() as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
    const results = (payload.items ?? []).slice(0, count).map((entry) => ({
      title: entry.title ?? "",
      url: entry.link ?? "",
      snippet: entry.snippet ?? "",
    }));
    if (results.length === 0) return null;
    return { query, results, provider: "google-cse" };
  } catch {
    return null;
  }
}

/** Firecrawl search: free tier 500 credits/mo. */
async function searchFirecrawl(query: string, count: number): Promise<WebSearchResult | null> {
  if (!FIRECRAWL_KEY) return null;
  try {
    const response = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${FIRECRAWL_KEY}`,
      },
      body: JSON.stringify({ query, limit: count }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { data?: Array<{ title?: string; url?: string; description?: string }> };
    const results = (payload.data ?? []).slice(0, count).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      snippet: entry.description ?? "",
    }));
    if (results.length === 0) return null;
    return { query, results, provider: "firecrawl" };
  } catch {
    return null;
  }
}

/** SearXNG: self-hosted meta-search. */
async function searchSearXNG(query: string, count: number): Promise<WebSearchResult | null> {
  if (!SEARXNG_URL) return null;
  try {
    const url = new URL(SEARXNG_URL.replace(/\/$/, "") + "/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (payload.results ?? []).slice(0, count).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      snippet: entry.content ?? "",
    }));
    if (results.length === 0) return null;
    return { query, results, provider: "searxng" };
  } catch {
    return null;
  }
}

/** DuckDuckGo Instant Answer: zero-config, returns abstracts + related topics (limited). */
async function searchDuckDuckGo(query: string, count: number): Promise<WebSearchResult | null> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const payload = await response.json() as {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
    };

    const results: { title: string; url: string; snippet: string }[] = [];

    if (payload.AbstractText && payload.AbstractURL) {
      results.push({ title: payload.AbstractText.slice(0, 80), url: payload.AbstractURL, snippet: payload.AbstractText });
    }

    for (const topic of payload.RelatedTopics ?? []) {
      if (topic.FirstURL && topic.Text) {
        results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
      }
      for (const sub of topic.Topics ?? []) {
        if (sub.FirstURL && sub.Text) {
          results.push({ title: sub.Text.slice(0, 80), url: sub.FirstURL, snippet: sub.Text });
        }
      }
    }

    if (results.length === 0) return null;
    return { query, results: results.slice(0, count), provider: "duckduckgo-instant" };
  } catch {
    return null;
  }
}

export async function webSearch(args: WebSearchArgs): Promise<WebSearchResult> {
  const count = Math.max(1, Math.min(args.count ?? 8, 20));

  // Try providers in order: Brave → Google CSE → Firecrawl → SearXNG → DuckDuckGo Instant
  const brave = await searchBrave(args.query, count);
  if (brave) return brave;

  const google = await searchGoogleCSE(args.query, count);
  if (google) return google;

  const firecrawl = await searchFirecrawl(args.query, count);
  if (firecrawl) return firecrawl;

  const searxng = await searchSearXNG(args.query, count);
  if (searxng) return searxng;

  const ddg = await searchDuckDuckGo(args.query, count);
  if (ddg) return ddg;

  return { query: args.query, results: [], provider: "none (set AGNI_BRAVE_API_KEY for free web search)" };
}

export interface WebFetchArgs {
  url: string;
  maxChars?: number;
}

/** Fetch page content. Uses Firecrawl for JS-rendered pages if configured, else fetchPage. */
export async function webFetch(args: WebFetchArgs): Promise<{ title: string | null; summary: string | null; url: string }> {
  if (FIRECRAWL_KEY) {
    try {
      const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${FIRECRAWL_KEY}`,
        },
        body: JSON.stringify({ url: args.url, formats: ["markdown"] }),
      });
      if (response.ok) {
        const payload = await response.json() as { data?: { markdown?: string; metadata?: { title?: string } } };
        const title = payload.data?.metadata?.title ?? null;
        let summary = payload.data?.markdown ?? null;
        if (args.maxChars && summary && summary.length > args.maxChars) {
          summary = summary.slice(0, args.maxChars) + "…";
        }
        return { title, summary, url: args.url };
      }
    } catch {
      // Fall through to fetchPage
    }
  }

  const page = await fetchPage(args.url);
  let summary = page.summary ?? null;
  if (args.maxChars && summary && summary.length > args.maxChars) {
    summary = summary.slice(0, args.maxChars) + "…";
  }
  return { title: page.title, summary, url: args.url };
}

/** Deep research: search + fetch top results, return compiled findings. */
export async function deepResearch(args: { query: string; depth?: number }): Promise<{
  query: string;
  findings: { title: string; url: string; snippet: string; content: string | null }[];
  provider: string;
}> {
  const depth = Math.max(1, Math.min(args.depth ?? 3, 5));
  const searchResult = await webSearch({ query: args.query, count: depth + 2 });
  const findings: { title: string; url: string; snippet: string; content: string | null }[] = [];

  const topResults = searchResult.results.slice(0, depth);
  const fetches = await Promise.allSettled(
    topResults.map(async (r) => {
      const page = await webFetch({ url: r.url, maxChars: 2000 });
      return { title: r.title, url: r.url, snippet: r.snippet, content: page.summary };
    }),
  );

  for (const f of fetches) {
    if (f.status === "fulfilled") findings.push(f.value);
  }

  return { query: args.query, findings, provider: searchResult.provider };
}