// Entry point for the scheduled cloud routine (see .claude/AUTOMATION.md).
// Deterministic-only: fetches/parses FIA transcripts and filters to known
// speakers. No LLM calls here — the cloud agent running this script does the
// FR digest writing itself, in its own turn, following AUTOMATION.md's rules.
//
// Usage:
//   npx tsx scripts/cloud-digest.ts list
//     -> JSON on stdout: { event, newTranscripts: [{ title, url, publishedAt, qas: [...] }] }
//        Transcripts already in data/telegram-seen.json are skipped.
//   npx tsx scripts/cloud-digest.ts mark-seen <url> [<url> ...]
//     -> records the given transcript URLs as seen (call after a successful send).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { determineCurrentEventName } from "../src/stories-data";
import { fetchTranscriptsForEvent } from "../src/fia";
import { extractContentBodyHtml, parseTranscriptBody } from "../src/transcript";
import { resolvePerson } from "../src/asset-manifest";

const SEEN_PATH = join(__dirname, "..", "data", "telegram-seen.json");
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)" };

function loadSeen(): Set<string> {
  if (!existsSync(SEEN_PATH)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(SEEN_PATH, "utf-8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(urls: Set<string>): void {
  mkdirSync(join(__dirname, "..", "data"), { recursive: true });
  writeFileSync(SEEN_PATH, JSON.stringify([...urls].sort(), null, 2), "utf-8");
}

async function cmdList(): Promise<void> {
  const event = await determineCurrentEventName();
  if (!event) {
    console.log(JSON.stringify({ event: null, newTranscripts: [] }));
    return;
  }

  const seen = loadSeen();
  const transcripts = await fetchTranscriptsForEvent(event);
  const fresh = transcripts.filter((t) => !seen.has(t.url));

  const newTranscripts = [];
  for (const t of fresh) {
    const res = await fetch(t.url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) continue;
    const html = await res.text();
    const bodyHtml = extractContentBodyHtml(html);
    if (!bodyHtml) continue;

    const qas = parseTranscriptBody(bodyHtml)
      .map((qa) => {
        const person = resolvePerson(qa.speaker);
        return person ? { speaker: person.name, role: person.role, team: person.team, isDriver: person.isDriver, question: qa.question, answer: qa.answer } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    newTranscripts.push({ title: t.title, url: t.url, publishedAt: t.publishedAt, qas });
  }

  console.log(JSON.stringify({ event, newTranscripts }, null, 2));
}

function cmdMarkSeen(urls: string[]): void {
  const seen = loadSeen();
  for (const u of urls) seen.add(u);
  saveSeen(seen);
  console.log(`Marked ${urls.length} URL(s) as seen (${seen.size} total).`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") return cmdList();
  if (cmd === "mark-seen") {
    if (rest.length === 0) throw new Error("mark-seen requires at least one URL");
    return cmdMarkSeen(rest);
  }
  console.error("Usage: npx tsx scripts/cloud-digest.ts <list|mark-seen <url...>>");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
