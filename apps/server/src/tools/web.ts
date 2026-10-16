/**
 * Web tools. web_search issues a SearXNG query (if configured) and web_fetch
 * reuses the existing fetchPage with the same SSRF protections.
 */
import { fetchPage } from "./fetch-url";

const SEARXNG_URL = process.env.AGNI_SEARXNG_URL?.trim();

export interface WebSearchArgs {
  query: string;
  count?: number;
}

export interface WebSearchResult {
  query: string;
  results: { title: string; url: string; snippet: string }[];
  provider: string;
}

export async function webSearch(args: WebSearchArgs): Promise<WebSearchResult> {
  if (!SEARXNG_URL) {
    return { query: args.query, results: [], provider: "none (set AGNI_SEARXNG_URL)" };
  }
  const url = new URL(SEARXNG_URL.replace(/\/$/, "") + "/search");
  url.searchParams.set("q", args.query);
  url.searchParams.set("format", "json");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
  const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const results = (payload.results ?? []).slice(0, Math.max(1, Math.min(args.count ?? 8, 20))).map((entry) => ({
    title: entry.title ?? "",
    url: entry.url ?? "",
    snippet: entry.content ?? "",
  }));
  return { query: args.query, results, provider: "searxng" };
}

export interface WebFetchArgs {
  url: string;
  maxChars?: number;
}

export async function webFetch(args: WebFetchArgs): Promise<{ title: string | null; summary: string | null }> {
  const page = await fetchPage(args.url);
  if (args.maxChars && (page.summary?.length ?? 0) > args.maxChars) {
    return { ...page, summary: page.summary ? `${page.summary.slice(0, args.maxChars)}…` : null };
  }
  return page;
}