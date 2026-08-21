// Generic RSS/Atom fetcher for the Articles tab — trimmed port of
// f1-editorial-os's lib/rss.ts (drops image extraction, which this port's
// list view doesn't render). Resilient by design: a broken feed never
// throws past this module, same as upstream — ingestNewsArticles() in
// server.ts turns a failure into a per-source report instead.

import Parser from "rss-parser";
import { isSafeExternalUrl } from "./safe-url";

export type NewsFeedItem = {
  title: string;
  url: string;
  summary: string | null;
  author: string | null;
  publishedAt: Date | null;
};

type CustomItem = { creator?: string; "content:encoded"?: string };

// HTML named entities that are invalid in XML but appear in real-world RSS feeds.
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&rsquo;": "’", "&lsquo;": "‘",
  "&rdquo;": "”", "&ldquo;": "“", "&mdash;": "—",
  "&ndash;": "–", "&hellip;": "…", "&amp;amp;": "&amp;",
  "&copy;": "©", "&reg;": "®", "&trade;": "™",
  "&eacute;": "é", "&egrave;": "è", "&agrave;": "à",
  "&apos;": "'",
};
const HTML_ENTITY_RE = new RegExp(
  Object.keys(HTML_ENTITIES).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "g",
);

function sanitizeXml(xml: string): string {
  return xml.replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] ?? m);
}

const parser: Parser<Record<string, unknown>, CustomItem> = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)",
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
  },
  customFields: { item: ["creator", "content:encoded"] },
});

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8230;|&hellip;/g, "…")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export type NewsFeedResult =
  | { ok: true; items: NewsFeedItem[] }
  | { ok: false; error: string };

export async function fetchNewsFeed(feedUrl: string): Promise<NewsFeedResult> {
  if (!isSafeExternalUrl(feedUrl)) {
    return { ok: false, error: "URL non autorisée (hôte privé/local)" };
  }
  try {
    const res = await fetch(feedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = sanitizeXml(await res.text());
    const feed = await parser.parseString(xml);
    const items: NewsFeedItem[] = (feed.items ?? [])
      .filter((it) => it.link && it.title)
      .map((it) => {
        const raw = (it as CustomItem)["content:encoded"] ?? it.contentSnippet ?? it.content ?? "";
        const summary = raw ? stripHtml(String(raw)).slice(0, 600) : null;
        const dateStr = it.isoDate ?? it.pubDate;
        const parsedDate = dateStr ? new Date(dateStr) : null;
        return {
          title: stripHtml(String(it.title)).slice(0, 300),
          url: it.link!.trim(),
          summary,
          author: (it as CustomItem).creator ?? it.creator ?? null,
          publishedAt: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : null,
        };
      });
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
