// Press sources for the Articles tab — port of f1-editorial-os's
// lib/sources-seed.ts, "news"/"official" categories only (the "press"
// filter its NewsPanel applies via mode=press). Reddit/community sources
// are left out: they need the LLM classify+translate pass from that
// project's lib/reddit.ts, which this port doesn't carry over.

export type NewsSourceCategory = "official" | "news";

export type NewsSource = {
  name: string;
  feedUrl: string;
  category: NewsSourceCategory;
};

export const NEWS_SOURCES: NewsSource[] = [
  { name: "RaceFans", feedUrl: "https://www.racefans.net/feed/", category: "news" },
  { name: "The Race", feedUrl: "https://www.the-race.com/feed/", category: "news" },
  { name: "Motorsport.com — F1", feedUrl: "https://www.motorsport.com/rss/f1/news/", category: "news" },
  { name: "Autosport — F1", feedUrl: "https://www.autosport.com/rss/feed/f1", category: "news" },
  { name: "PlanetF1", feedUrl: "https://www.planetf1.com/rss/", category: "news" },
  { name: "GPFans", feedUrl: "https://www.gpfans.com/en/rss.xml", category: "news" },
  {
    name: "Formula1.com (officiel)",
    feedUrl: "https://www.formula1.com/content/fom-website/en/latest/all.xml",
    category: "official",
  },
];
