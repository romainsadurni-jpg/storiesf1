// Entry point for the GitHub Actions workflow (.github/workflows/fia-watch.yml).
// Fully deterministic, zero LLM/API calls: fetches/parses new FIA press
// conference transcripts, filters to known speakers, and sends the raw
// English Q&A as a digest to Telegram so the user can pick which ones to
// turn into French visual stories later (that step happens interactively,
// locally, with scripts/gen_stories_from_transcript.ts — not here).
//
// Usage: npx tsx scripts/cloud-digest.ts
// Requires env vars TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
// Exits 0 whether or not anything new was found; only fails on a real error.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { determineCurrentEventName } from "../src/stories-data";
import { fetchTranscriptsForEvent } from "../src/fia";
import { extractContentBodyHtml, parseTranscriptBody } from "../src/transcript";
import { eligibleEntries } from "../src/digest";

const SEEN_PATH = join(__dirname, "..", "data", "telegram-seen.json");
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)" };
const MAX_MESSAGE_LEN = 3500;
const MAX_ANSWER_LEN = 400;

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

async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendMessage failed: ${data.description ?? res.status}`);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function escapeMarkdown(s: string): string {
  // Telegram legacy Markdown only needs these escaped to avoid breaking formatting.
  return s.replace(/([*_`\[])/g, "\\$1");
}

type EligibleQa = { speaker: string; role: string; team: string; question: string; answer: string };

function buildMessages(title: string, url: string, qas: EligibleQa[]): string[] {
  const entries = qas.map((qa, i) => {
    const idx = i + 1;
    return `${idx}. *${escapeMarkdown(qa.speaker)}* (${escapeMarkdown(qa.team)}) — _${escapeMarkdown(truncate(qa.question, 140))}_\n${escapeMarkdown(truncate(qa.answer, MAX_ANSWER_LEN))}`;
  });

  const messages: string[] = [];
  let current = `🏁 *${escapeMarkdown(title)}*\n\n`;
  let part = 1;
  const flush = (isLast: boolean) => {
    messages.push(current + (isLast ? `\n${url}` : ""));
  };

  for (const entry of entries) {
    if (current.length + entry.length + 2 > MAX_MESSAGE_LEN) {
      part++;
      messages.push(current);
      current = `🏁 *${escapeMarkdown(title)}* (suite ${part})\n\n`;
    }
    current += entry + "\n\n";
  }
  messages.push(current + `\n${url}`);
  return messages;
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars are required");

  const event = await determineCurrentEventName();
  if (!event) {
    console.log("No current Grand Prix found — nothing to do.");
    return;
  }
  console.log(`Current event: ${event}`);

  const seen = loadSeen();
  const transcripts = await fetchTranscriptsForEvent(event);
  const fresh = transcripts.filter((t) => !seen.has(t.url));
  console.log(`${transcripts.length} transcript(s) found, ${fresh.length} new.`);

  let sentAny = false;

  for (const t of fresh) {
    console.log(`Processing: ${t.title}`);
    let bodyHtml: string | null = null;
    try {
      const res = await fetch(t.url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      bodyHtml = extractContentBodyHtml(html);
    } catch (e) {
      console.error(`  fetch/parse failed, will retry next run: ${e instanceof Error ? e.message : e}`);
      continue; // don't mark seen — retry next time
    }
    if (!bodyHtml) {
      console.error(`  content-body not found, will retry next run`);
      continue;
    }

    const qas: EligibleQa[] = eligibleEntries(parseTranscriptBody(bodyHtml)).map(({ qa, person }) => ({
      speaker: person.name,
      role: person.role,
      team: person.team,
      question: qa.question,
      answer: qa.answer,
    }));

    if (qas.length === 0) {
      console.log(`  no eligible speakers, marking seen with nothing to send`);
      seen.add(t.url);
      continue;
    }

    try {
      const messages = buildMessages(t.title, t.url, qas);
      for (const msg of messages) await sendTelegramMessage(token, chatId, msg);
      console.log(`  sent ${messages.length} Telegram message(s), ${qas.length} quote(s)`);
      seen.add(t.url);
      sentAny = true;
    } catch (e) {
      console.error(`  Telegram send failed, will retry next run: ${e instanceof Error ? e.message : e}`);
      // don't mark seen — retry next time
    }
  }

  saveSeen(seen);
  console.log(sentAny ? "Done — digest sent." : "Done — nothing new to send.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
