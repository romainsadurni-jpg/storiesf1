// Local stand-in for f1-editorial-os's StoryItem table: FIA transcripts and
// documents already fetched for a given event, cached to disk so re-viewing
// an event doesn't re-scrape fia.com every time. One JSON file per event.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchTranscriptsForEvent, fetchFiaDocuments, type FiaTranscript, type FiaDocument } from "./fia";

const FIA_DIR = join(__dirname, "..", "data", "fia");

function eventFileSlug(eventName: string): string {
  return eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export type EventFiaData = { transcripts: FiaTranscript[]; documents: FiaDocument[]; fetchedAt: string | null };

function path(eventName: string): string {
  return join(FIA_DIR, `${eventFileSlug(eventName)}.json`);
}

export function getFiaData(eventName: string): EventFiaData {
  const p = path(eventName);
  if (!existsSync(p)) return { transcripts: [], documents: [], fetchedAt: null };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as EventFiaData;
  } catch {
    return { transcripts: [], documents: [], fetchedAt: null };
  }
}

function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true)));
}

/** Fetches fresh transcripts + documents for an event and merges them into
 * the cache (dedup by URL — a re-fetch only ever adds newly-published items,
 * it never loses ones fetched earlier in the weekend). */
export async function refreshFiaData(eventName: string): Promise<{ addedTranscripts: number; addedDocuments: number }> {
  const [freshTranscripts, freshDocuments] = await Promise.all([
    fetchTranscriptsForEvent(eventName),
    fetchFiaDocuments(eventName),
  ]);

  const existing = getFiaData(eventName);
  const knownTranscriptUrls = new Set(existing.transcripts.map((t) => t.url));
  const knownDocumentUrls = new Set(existing.documents.map((d) => d.url));

  const merged: EventFiaData = {
    transcripts: dedupeByUrl([...existing.transcripts, ...freshTranscripts]),
    documents: dedupeByUrl([...existing.documents, ...freshDocuments]),
    fetchedAt: new Date().toISOString(),
  };

  mkdirSync(FIA_DIR, { recursive: true });
  writeFileSync(path(eventName), JSON.stringify(merged, null, 2), "utf-8");

  return {
    addedTranscripts: freshTranscripts.filter((t) => !knownTranscriptUrls.has(t.url)).length,
    addedDocuments: freshDocuments.filter((d) => !knownDocumentUrls.has(d.url)).length,
  };
}
