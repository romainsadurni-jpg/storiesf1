// Full-article body extraction — port of f1-editorial-os's
// lib/article-fetcher.ts, with a local file cache instead of a DB column.

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeExternalUrl } from "./safe-url";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// "What the teams said" articles cover all 11 constructors — needs to stay
// whole for the per-team section splitter (see synthesis.ts) to reach every
// team, not just the first few. A real 6-team excerpt runs ~20000 chars, so
// the full 11-team article needs real headroom above that; 20000 silently
// truncated after Audi and dropped the last 5 teams. f1-editorial-os caps
// single-subject articles at 6000 chars for tweet-generation prompts; that
// cap doesn't apply here.
const MAX_CHARS = 60000;

function truncateAtBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastPara = cut.lastIndexOf("\n\n");
  if (lastPara > max * 0.6) return cut.slice(0, lastPara).trim();
  const lastSentence = cut.lastIndexOf(". ");
  if (lastSentence > max * 0.6) return cut.slice(0, lastSentence + 1).trim();
  return cut.trim();
}

function cacheKeyFromUrl(url: string): string {
  return url.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(-150);
}

const CACHE_DIR = join(__dirname, "..", "data", "fulltext");

function readCache(url: string): string | null {
  const path = join(CACHE_DIR, `${cacheKeyFromUrl(url)}.txt`);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

function writeCache(url: string, text: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${cacheKeyFromUrl(url)}.txt`), text, "utf-8");
}

/** Fetches and extracts clean article text, cached to a local file per URL. */
export async function getArticleFullText(url: string): Promise<string | null> {
  const cached = readCache(url);
  if (cached) return cached;

  if (!isSafeExternalUrl(url)) {
    console.warn(`[article-fetcher] blocked unsafe URL: ${url}`);
    return null;
  }

  let html: string;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[article-fetcher] HTTP ${res.status} for ${url}`);
      return null;
    }
    html = await res.text();
  } catch (e) {
    console.warn(`[article-fetcher] fetch failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const text = article?.textContent?.trim();
    if (!text || text.length < 200) {
      console.warn(`[article-fetcher] empty/short extraction for ${url} (got ${text?.length ?? 0} chars)`);
      return null;
    }
    const compact = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    const truncated = truncateAtBoundary(compact, MAX_CHARS);
    writeCache(url, truncated);
    console.log(`[article-fetcher] OK ${url} -> ${truncated.length} chars`);
    return truncated;
  } catch (e) {
    console.warn(`[article-fetcher] parse failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
