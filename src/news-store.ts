// Local stand-in for f1-editorial-os's Article table (Postgres) — press
// articles pulled from NEWS_SOURCES, accumulated across syncs and scored
// on read. Same one-JSON-file pattern as article-store.ts, kept as a
// separate file/store because these are general press articles, not
// "What the teams said" quote pieces.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewsFeedItem } from "./news-rss";
import type { NewsSourceCategory } from "./news-sources";

export type StoredNewsArticle = {
  url: string;
  title: string;
  summary: string | null;
  author: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  source: string;
  sourceCategory: NewsSourceCategory;
  // "Not interesting" in f1-editorial-os deletes the row outright (backed
  // by a DismissedRef table so it never comes back on the next sync). A
  // single JSON store can't cheaply tell "never seen" from "seen and
  // dismissed" without that second table, so a flag serves both roles here.
  dismissed: boolean;
  // Set once a "Générer les stories" pass has processed this article, so
  // repeated passes skip it instead of re-spending an LLM call + render.
  // `storyPath` is a path relative to the project root (under output/),
  // ready to serve statically; null on a skip/failure, with the reason kept
  // in `storySkipReason` for display.
  storyPath: string | null;
  storySkipReason: string | null;
};

const DATA_DIR = join(__dirname, "..", "data");
const NEWS_PATH = join(DATA_DIR, "news-articles.json");

function load(): StoredNewsArticle[] {
  if (!existsSync(NEWS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(NEWS_PATH, "utf-8")) as StoredNewsArticle[];
  } catch {
    return [];
  }
}

function save(articles: StoredNewsArticle[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(NEWS_PATH, JSON.stringify(articles, null, 2), "utf-8");
}

export function listNewsArticles(): StoredNewsArticle[] {
  return load().filter((a) => !a.dismissed);
}

/** Merges newly-fetched feed items into the store (dedup by URL, dismissed URLs excluded). Returns how many were actually new. */
export function addNewsArticles(source: string, sourceCategory: NewsSourceCategory, items: NewsFeedItem[]): number {
  const articles = load();
  const known = new Set(articles.map((a) => a.url));
  const fresh = items.filter((i) => !known.has(i.url));
  const now = new Date().toISOString();
  articles.push(
    ...fresh.map((item) => ({
      url: item.url,
      title: item.title,
      summary: item.summary,
      author: item.author,
      publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
      fetchedAt: now,
      source,
      sourceCategory,
      dismissed: false,
      storyPath: null,
      storySkipReason: null,
    })),
  );
  if (fresh.length > 0) save(articles);
  return fresh.length;
}

export function dismissNewsArticle(url: string): void {
  const articles = load();
  const article = articles.find((a) => a.url === url);
  if (!article) return;
  article.dismissed = true;
  save(articles);
}

/** Records the outcome of a "Générer les stories" pass for one article —
 * either a rendered card (`storyPath` set) or a skip/failure (`reason` set,
 * `storyPath` left null) — so the next pass doesn't reprocess it. */
export function setStoryResult(url: string, result: { storyPath: string } | { reason: string }): void {
  const articles = load();
  const article = articles.find((a) => a.url === url);
  if (!article) return;
  if ("storyPath" in result) {
    article.storyPath = result.storyPath;
    article.storySkipReason = null;
  } else {
    article.storyPath = null;
    article.storySkipReason = result.reason;
  }
  save(articles);
}
