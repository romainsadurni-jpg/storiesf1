// Local stand-in for f1-editorial-os's Article table (Postgres): every
// "What the teams said" item ever seen, accumulated across repeated syncs.
// This is what lets event-matching (see stories-data.ts) work for GPs whose
// articles have already scrolled out of F1.com's ~10-item feed window —
// exactly the role the Postgres table plays there, just as one JSON file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WttsFeedItem } from "./rss";
import type { WttsTeamSynthesis } from "./synthesis";

export type StoredArticle = {
  title: string;
  url: string;
  publishedAt: string | null;
  fetchedAt: string;
  teamsSynthesis: WttsTeamSynthesis[] | null;
};

const DATA_DIR = join(__dirname, "..", "data");
const ARTICLES_PATH = join(DATA_DIR, "articles.json");

function load(): StoredArticle[] {
  if (!existsSync(ARTICLES_PATH)) return [];
  try {
    return JSON.parse(readFileSync(ARTICLES_PATH, "utf-8")) as StoredArticle[];
  } catch {
    return [];
  }
}

function save(articles: StoredArticle[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ARTICLES_PATH, JSON.stringify(articles, null, 2), "utf-8");
}

export function getAllArticles(): StoredArticle[] {
  return load();
}

/** Merges newly-fetched feed items into the store (dedup by URL). Returns the ones that were actually new. */
export function addArticles(items: WttsFeedItem[]): StoredArticle[] {
  const articles = load();
  const known = new Set(articles.map((a) => a.url));
  const fresh = items.filter((i) => !known.has(i.url));
  const newlyStored: StoredArticle[] = fresh.map((item) => ({
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
    fetchedAt: new Date().toISOString(),
    teamsSynthesis: null,
  }));
  articles.push(...newlyStored);
  if (newlyStored.length > 0) save(articles);
  return newlyStored;
}

export function setSynthesis(url: string, teams: WttsTeamSynthesis[]): void {
  const articles = load();
  const article = articles.find((a) => a.url === url);
  if (!article) return;
  article.teamsSynthesis = teams;
  save(articles);
}
