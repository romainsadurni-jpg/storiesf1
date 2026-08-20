// FIA.com connector (Drupal 7, server-rendered — no auth, no public API).
// Direct port of f1-editorial-os's lib/fia.ts, with the Prisma-backed cache
// swapped for the local file cache (json-cache.ts).
//
// Two independent scrapers:
//  - Press conference transcripts: FIA publishes these at predictable URLs
//    (f1-{year}-{event-slug}-{session}-press-conference-transcript). The
//    general /rss/news feed only holds ~10 items across every FIA discipline
//    (WEC, Rally, Formula E, ...), so a transcript is usually gone from it
//    before the next check — URL guessing + a content check is the only
//    reliable path. A guessed URL that doesn't exist still returns HTTP 200
//    (Drupal serves a generic "News" listing page instead of a 404), so a
//    hit is only confirmed by checking og:title actually names a transcript.
//  - Decision documents (penalties, classifications, stewards rulings): FIA
//    exposes a per-event page under /documents listing every PDF published
//    for that Grand Prix. The event URL embeds a season taxonomy id that
//    changes every year, so it's resolved dynamically from the season's
//    default documents page rather than hardcoded.

import { cachedJson } from "./json-cache";

const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)" };
const TIMEOUT_MS = 15_000;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&rsquo;|&#8217;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—");
}

function slugifyEvent(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---- Press conference transcripts ------------------------------------------

export type FiaTranscript = {
  title: string;
  url: string;
  summary: string | null;
  publishedAt: string | null;
};

const TRANSCRIPT_SESSIONS = ["thursday", "friday", "post-sprint", "post-qualifying", "post-race"];

async function fetchTranscriptPage(url: string): Promise<FiaTranscript | null> {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const html = await res.text();
    const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
    if (!title || !/press conference transcript/i.test(title)) return null;
    const description = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1];
    const updatedAt = html.match(/<meta property="og:updated_time" content="([^"]*)"/)?.[1];
    const d = updatedAt ? new Date(updatedAt) : null;
    return {
      title: decodeEntities(title),
      url,
      summary: description ? decodeEntities(description).slice(0, 600) : null,
      publishedAt: d && !isNaN(d.getTime()) ? d.toISOString() : null,
    };
  } catch {
    return null;
  }
}

/** Tries every known press-conference-transcript URL for a Grand Prix; keeps only the ones that exist. */
export async function fetchTranscriptsForEvent(eventName: string): Promise<FiaTranscript[]> {
  const slug = slugifyEvent(eventName);
  const year = new Date().getFullYear();
  const results = await Promise.all(
    TRANSCRIPT_SESSIONS.map((session) =>
      fetchTranscriptPage(`https://www.fia.com/news/f1-${year}-${slug}-${session}-press-conference-transcript`),
    ),
  );
  return results.filter((r): r is FiaTranscript => r !== null);
}

// ---- Decision documents (penalties, classifications, stewards rulings) ----

export type FiaDocument = {
  title: string;
  url: string;
  publishedAt: string | null;
  isPenalty: boolean;
};

const PENALTY_RE = /infringement|penalt|reprimand|summons|disqualif|offence|breach|non[- ]compliance/i;

type FiaEvent = { name: string; href: string };

async function resolveSeasonUrl(year: number): Promise<string | null> {
  try {
    const res = await fetch("https://www.fia.com/documents/championships/fia-formula-one-world-championship-14", {
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(new RegExp(`<option value="([^"]*\\/season\\/season-${year}-\\d+)">SEASON ${year}`));
    return m ? `https://www.fia.com${m[1]}` : null;
  } catch {
    return null;
  }
}

async function fetchSeasonEventOptions(): Promise<FiaEvent[]> {
  const seasonUrl = await resolveSeasonUrl(new Date().getFullYear());
  if (!seasonUrl) return [];
  try {
    const res = await fetch(seasonUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const html = await res.text();
    const optionRe = /<option value="([^"]*\/event\/[^"]+)">([^<]+)</g;
    const events: FiaEvent[] = [];
    let m: RegExpExecArray | null;
    while ((m = optionRe.exec(html))) {
      events.push({ name: decodeEntities(m[2]).trim(), href: m[1] });
    }
    return events;
  } catch {
    return [];
  }
}

// 6h TTL (season calendar barely changes) so the dropdown and every document
// lookup don't each re-scrape the FIA season page.
async function cachedSeasonEventOptions(): Promise<FiaEvent[]> {
  return cachedJson(`fia:events:${new Date().getFullYear()}`, 6 * 60 * 60, fetchSeasonEventOptions);
}

/** Every Grand Prix on the current FIA season calendar, in championship order. */
export async function fetchSeasonEventNames(): Promise<string[]> {
  const events = await cachedSeasonEventOptions();
  return events.map((e) => e.name);
}

async function resolveEventDocumentsUrl(eventName: string): Promise<string | null> {
  const events = await cachedSeasonEventOptions();
  const target = normalizeForMatch(eventName);
  const found = events.find((e) => normalizeForMatch(e.name) === target);
  return found ? `https://www.fia.com${found.href}` : null;
}

function parseFiaDate(raw: string): string | null {
  // "05.07.26 21:40"
  const m = raw.match(/(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yy, hh, min] = m;
  const d = new Date(`20${yy}-${mm}-${dd}T${hh}:${min}:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** All decision documents published for a Grand Prix (penalties flagged via `isPenalty`). */
export async function fetchFiaDocuments(eventName: string): Promise<FiaDocument[]> {
  const pageUrl = await resolveEventDocumentsUrl(eventName);
  if (!pageUrl) return [];
  try {
    const res = await fetch(pageUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const html = await res.text();
    const blocks = html.split('<li class="document-row').slice(1);
    const docs: FiaDocument[] = [];
    for (const block of blocks) {
      const href = block.match(/href="([^"]+\.pdf)"/)?.[1];
      const titleSection = block.match(
        /<div class="title">([\s\S]*?)(?:<div class="panel-separator">|<div class="published">)/,
      )?.[1];
      const titleText = titleSection?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!href || !titleText) continue;
      const dateText = block.match(/date-display-single">([^<]+)</)?.[1];
      const title = decodeEntities(titleText);
      docs.push({
        title,
        url: `https://www.fia.com${href}`,
        publishedAt: dateText ? parseFiaDate(dateText.trim()) : null,
        isPenalty: PENALTY_RE.test(title),
      });
    }
    return docs;
  } catch {
    return [];
  }
}
