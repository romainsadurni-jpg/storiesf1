// Pulls every NEWS_SOURCES feed and merges new items into news-store.ts —
// shared by the web UI's "Rafraîchir" button (server.ts) and the automated
// Telegram digest (scripts/articles-digest.ts).

import { NEWS_SOURCES } from "./news-sources";
import { fetchNewsFeed } from "./news-rss";
import { addNewsArticles } from "./news-store";

export async function ingestNewsArticles(): Promise<{ totalAdded: number; errors: string[] }> {
  const results = await Promise.all(
    NEWS_SOURCES.map(async (src) => {
      const result = await fetchNewsFeed(src.feedUrl);
      if (!result.ok) return { source: src.name, added: 0, error: result.error };
      const added = addNewsArticles(src.name, src.category, result.items);
      return { source: src.name, added, error: undefined as string | undefined };
    }),
  );
  return {
    totalAdded: results.reduce((s, r) => s + r.added, 0),
    errors: results.filter((r) => r.error).map((r) => `${r.source}: ${r.error}`),
  };
}
