// F1.com "What the teams said" feed — simplified port of
// f1-editorial-os's lib/rss.ts, trimmed to what this pipeline needs
// (title/url/date only — full body comes from article-fetcher.ts).

import Parser from "rss-parser";
import { isSafeExternalUrl } from "./safe-url";

const FEED_URL = "https://www.formula1.com/content/fom-website/en/latest/all.xml";

export type WttsFeedItem = {
  title: string;
  url: string;
  publishedAt: Date | null;
};

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)",
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
  },
});

/** Every "What the teams said" item currently in F1.com's latest-news feed. */
export async function fetchWttsFeedItems(): Promise<WttsFeedItem[]> {
  if (!isSafeExternalUrl(FEED_URL)) throw new Error("Feed URL rejected by safety check");

  const res = await fetch(FEED_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`F1.com feed HTTP ${res.status}`);
  const xml = await res.text();
  const feed = await parser.parseString(xml);

  return (feed.items ?? [])
    .filter((item) => item.link && item.title && /^what the teams said/i.test(item.title))
    .map((item) => ({
      title: item.title!.trim(),
      url: item.link!.trim(),
      publishedAt: item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : null,
    }));
}
