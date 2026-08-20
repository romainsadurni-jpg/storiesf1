// Orchestration layer — port of f1-editorial-os's lib/stories.ts, adapted
// to read/write the local JSON stores (article-store.ts, fia-store.ts)
// instead of Postgres via Prisma. Same matching logic, same reasoning.

import { getLastRace, getNextRace, getCurrentSchedule, type RaceInfo } from "./jolpica";
import { fetchSeasonEventNames } from "./fia";
import { getFiaData, refreshFiaData } from "./fia-store";
import { getAllArticles, addArticles, type StoredArticle } from "./article-store";
import { fetchWttsFeedItems } from "./rss";

/** The Grand Prix currently "live" for editorial purposes: whichever of the
 * last-completed or next-upcoming race is closer to today. Used as the
 * dropdown's default selection, not a hard constraint. */
export async function determineCurrentEventName(): Promise<string | null> {
  const [last, next] = await Promise.all([getLastRace(), getNextRace()]);
  const candidates = [last, next].filter((r): r is RaceInfo => r !== null);
  if (candidates.length === 0) return null;
  const now = Date.now();
  candidates.sort(
    (a, b) => Math.abs(new Date(a.date).getTime() - now) - Math.abs(new Date(b.date).getTime() - now),
  );
  return candidates[0].raceName;
}

// F1.com's "What the teams said" titles end in "in <Location>", and that
// location is the country NOUN, not the GP's adjective ("Hungarian Grand
// Prix" → "in Hungary", "Belgian Grand Prix" → "in Belgium") — irregular
// enough that a suffix-strip can't derive one from the other, so every
// adjective-named GP needs an explicit entry. GPs already named after their
// country/city as a noun (Monaco, Miami, Bahrain, Singapore, Qatar,
// Azerbaijan, Las Vegas, Abu Dhabi) don't need one — the generic fallback
// (stripping " Grand Prix") already matches those.
const QUOTE_LOCATION_ALIASES: Record<string, string[]> = {
  "australian grand prix": ["australia"],
  "chinese grand prix": ["china"],
  "japanese grand prix": ["japan"],
  "canadian grand prix": ["canada"],
  "austrian grand prix": ["austria"],
  "belgian grand prix": ["belgium"],
  "hungarian grand prix": ["hungary"],
  "italian grand prix": ["italy", "monza"],
  "dutch grand prix": ["netherlands", "zandvoort"],
  "british grand prix": ["great britain", "britain"],
  "spanish grand prix": ["spain", "barcelona"],
  "barcelona-catalunya grand prix": ["barcelona", "spain", "catalunya"],
  "saudi arabian grand prix": ["saudi arabia", "jeddah"],
  "united states grand prix": ["austin", "united states"],
  "mexico city grand prix": ["mexico"],
  "sao paulo grand prix": ["brazil", "sao paulo", "interlagos"],
  "emilia romagna grand prix": ["imola", "emilia"],
};

function quoteKeywordsForEvent(eventName: string): string[] {
  const key = eventName.toLowerCase().trim();
  if (QUOTE_LOCATION_ALIASES[key]) return QUOTE_LOCATION_ALIASES[key];
  const base = key.replace(/\s*grand prix\s*$/i, "").trim();
  return base ? [base] : [];
}

function raceBaseName(raceName: string): string {
  return raceName.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/grandprix$/, "");
}

function raceNamesMatch(a: string, b: string): boolean {
  const ba = raceBaseName(a);
  const bb = raceBaseName(b);
  return ba.length > 0 && bb.length > 0 && (ba === bb || ba.includes(bb) || bb.includes(ba));
}

function orderEventsChronologically(events: string[], schedule: RaceInfo[]): string[] {
  if (events.length <= 1 || schedule.length === 0) return events;
  const roundByBase = new Map<string, number>();
  for (const r of schedule) {
    const base = raceBaseName(r.raceName);
    if (base) roundByBase.set(base, parseInt(r.round, 10));
  }
  function roundFor(eventName: string): number | null {
    const base = raceBaseName(eventName);
    if (roundByBase.has(base)) return roundByBase.get(base)!;
    for (const [schedBase, round] of roundByBase) {
      if (base.includes(schedBase) || schedBase.includes(base)) return round;
    }
    return null;
  }
  return [...events].sort((a, b) => {
    const ra = roundFor(a);
    const rb = roundFor(b);
    if (ra !== null && rb !== null) return ra - rb;
    if (ra !== null) return -1;
    if (rb !== null) return 1;
    return a.localeCompare(b);
  });
}

// F1.com's RSS feed carries no <pubDate> for these articles most of the
// time, but `fetchedAt` tracks the real event closely — items are picked up
// within hours of publication. That makes date-proximity to a scheduled
// race a reliable, GP-agnostic matching signal that needs zero per-GP
// guessing, unlike QUOTE_LOCATION_ALIASES above. It's the fallback here
// (not the only check) because a big catch-up sync after a pause would
// cluster fetchedAt away from the real weekend — the keyword hint stays
// authoritative whenever it's known to be right.
function nearestRaceForDate(date: Date, schedule: RaceInfo[]): RaceInfo | null {
  let best: RaceInfo | null = null;
  let bestDiff = Infinity;
  for (const r of schedule) {
    const diff = Math.abs(new Date(r.date).getTime() - date.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

function findQuoteArticlesForEvent(eventName: string, schedule: RaceInfo[], articles: StoredArticle[]): StoredArticle[] {
  const keywords = quoteKeywordsForEvent(eventName);
  return articles.filter((a) => {
    const titleLower = a.title.toLowerCase();
    if (keywords.some((kw) => titleLower.includes(kw))) return true;
    // The title names a different GP outright (e.g. "in Hungary" while we're
    // looking for the Dutch GP) — that's decisive on its own, so don't let
    // the date fallback below override it with a same-day ingestion fluke
    // (a backfill or a re-sync run near another GP's weekend).
    const namesOtherEvent = schedule.some(
      (r) => !raceNamesMatch(r.raceName, eventName) && quoteKeywordsForEvent(r.raceName).some((kw) => titleLower.includes(kw)),
    );
    if (namesOtherEvent) return false;
    const nearest = nearestRaceForDate(new Date(a.fetchedAt), schedule);
    return nearest ? raceNamesMatch(nearest.raceName, eventName) : false;
  });
}

export type IngestReport = {
  event: string | null;
  newArticles: number;
  addedTranscripts: number;
  addedDocuments: number;
  error?: string;
};

/** Pulls fresh "What the teams said" items into the local article store,
 * and refreshes FIA transcripts/documents for the given (or current) event. */
export async function ingestStories(eventName?: string): Promise<IngestReport> {
  const event = eventName ?? (await determineCurrentEventName());
  if (!event) {
    return { event: null, newArticles: 0, addedTranscripts: 0, addedDocuments: 0, error: "Grand Prix en cours introuvable." };
  }

  const feedItems = await fetchWttsFeedItems();
  const newArticles = addArticles(feedItems);

  const { addedTranscripts, addedDocuments } = await refreshFiaData(event);

  return { event, newArticles: newArticles.length, addedTranscripts, addedDocuments };
}

export type StoriesContent = {
  event: string | null;
  events: string[];
  quotes: StoredArticle[];
  transcripts: { title: string; url: string; publishedAt: string | null }[];
  documents: { title: string; url: string; publishedAt: string | null; isPenalty: boolean }[];
};

/** Reads everything already known for one Grand Prix — no network calls,
 * purely local. Call ingestStories() first (or the "Rafraîchir" action) to
 * populate/refresh what this reads. */
export async function listStories(eventName?: string): Promise<StoriesContent> {
  const event = eventName ?? (await determineCurrentEventName());

  const [schedule, rawEvents] = await Promise.all([
    getCurrentSchedule().catch(() => [] as RaceInfo[]),
    fetchSeasonEventNames().catch(() => [] as string[]),
  ]);
  const events = orderEventsChronologically(rawEvents, schedule);

  if (!event) return { event: null, events, quotes: [], transcripts: [], documents: [] };

  const allArticles = getAllArticles();
  const quotes = findQuoteArticlesForEvent(event, schedule, allArticles)
    .filter((a) => /^what the teams said/i.test(a.title))
    .sort((a, b) => new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime());

  const fia = getFiaData(event);

  return {
    event,
    events,
    quotes,
    transcripts: fia.transcripts
      .slice()
      .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime()),
    documents: fia.documents
      .slice()
      .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime()),
  };
}
