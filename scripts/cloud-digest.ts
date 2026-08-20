// Entry point for the GitHub Actions workflow (.github/workflows/fia-watch.yml).
// Fully unattended, no LLM/agent usage: fetches new FIA press conference
// transcripts, translates every eligible Q&A pair literally (MyMemory, free,
// keyless — src/translate.ts, deliberately NOT an editorial LLM rewrite),
// renders each as a quote-card PNG (Puppeteer-bundled Chromium, works the
// same in CI as locally), and sends them straight to Telegram as photo
// albums. Every eligible quote becomes a card — no manual picking step.
//
// Usage: npx tsx scripts/cloud-digest.ts
// Requires env vars TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { determineCurrentEventName } from "../src/stories-data";
import { fetchTranscriptsForEvent } from "../src/fia";
import { extractContentBodyHtml, parseTranscriptBody } from "../src/transcript";
import { eligibleEntries, type EligibleEntry } from "../src/digest";
import { backgroundFor } from "../src/asset-manifest";
import { translateToFrench, truncateWords } from "../src/translate";
import { renderCardPuppeteer, closeBrowser } from "../src/puppeteer-render";

const BASE = join(__dirname, "..");
const TEMPLATES_DIR = join(BASE, "templates");
const TEMPLATE_PATH = join(TEMPLATES_DIR, "quote-card.html");
const SEEN_PATH = join(BASE, "data", "telegram-seen.json");
const HANDLE = "@SaD_F1";
const HTTP_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)" };

// Pre-translation caps keep each MyMemory request under its ~500-char
// anonymous-tier limit; post-translation caps keep the card readable.
const ANSWER_SOURCE_CAP = 420;
const QUESTION_SOURCE_CAP = 220;
const QUOTE_DISPLAY_CAP = 280;
const CONTEXT_DISPLAY_CAP = 120;
const TRANSLATE_DELAY_MS = 300; // be polite to a free, shared, keyless API
const MEDIA_GROUP_SIZE = 10; // Telegram's max per sendMediaGroup call

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadSeen(): Set<string> {
  if (!existsSync(SEEN_PATH)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(SEEN_PATH, "utf-8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(urls: Set<string>): void {
  mkdirSync(join(BASE, "data"), { recursive: true });
  writeFileSync(SEEN_PATH, JSON.stringify([...urls].sort(), null, 2), "utf-8");
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

type PhotoItem = { path: string; caption: string };

async function sendTelegramPhoto(token: string, chatId: string, item: PhotoItem): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", item.caption);
  form.append("photo", new Blob([readFileSync(item.path)], { type: "image/png" }), item.path.split(/[\\/]/).pop());
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendPhoto failed: ${data.description ?? res.status}`);
}

async function sendTelegramMediaGroup(token: string, chatId: string, items: PhotoItem[]): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  const media = items.map((item, i) => ({ type: "photo", media: `attach://file${i}`, caption: item.caption.slice(0, 1024) }));
  form.append("media", JSON.stringify(media));
  items.forEach((item, i) => {
    form.append(`file${i}`, new Blob([readFileSync(item.path)], { type: "image/png" }), `file${i}.png`);
  });
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendMediaGroup failed: ${data.description ?? res.status}`);
}

async function sendPhotosInBatches(token: string, chatId: string, items: PhotoItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += MEDIA_GROUP_SIZE) {
    const batch = items.slice(i, i + MEDIA_GROUP_SIZE);
    if (batch.length === 1) await sendTelegramPhoto(token, chatId, batch[0]);
    else await sendTelegramMediaGroup(token, chatId, batch);
  }
}

/** Translates `text` (truncated to stay under MyMemory's request cap) to
 * French, then truncates the result to `displayCap` for the card. */
async function translateForCard(text: string, sourceCap: number, displayCap: number): Promise<string> {
  const source = truncateWords(text, sourceCap);
  const translated = await translateToFrench(source);
  return truncateWords(translated, displayCap);
}

function buildContext(translatedQuestion: string): string {
  const stripped = translatedQuestion.replace(/[?.!…]+$/, "").trim();
  return stripped ? `${stripped[0].toUpperCase()}${stripped.slice(1)} :` : "";
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

  const templateSrc = readFileSync(TEMPLATE_PATH, "utf-8");

  for (const t of fresh) {
    console.log(`Processing: ${t.title}`);
    let bodyHtml: string | null = null;
    try {
      const res = await fetch(t.url, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      bodyHtml = extractContentBodyHtml(html);
    } catch (e) {
      console.error(`  fetch/parse failed, will retry next run: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!bodyHtml) {
      console.error(`  content-body not found, will retry next run`);
      continue;
    }

    let entries: EligibleEntry[] = eligibleEntries(parseTranscriptBody(bodyHtml));
    console.log(`  ${entries.length} eligible Q&A pair(s).`);
    // Debug-only cap for local testing (never set in the GitHub Actions
    // workflow) — production always processes every eligible entry.
    const debugLimit = process.env.DIGEST_DEBUG_LIMIT ? parseInt(process.env.DIGEST_DEBUG_LIMIT, 10) : null;
    if (debugLimit) {
      entries = entries.slice(0, debugLimit);
      console.log(`  DIGEST_DEBUG_LIMIT set: capped to ${entries.length}.`);
    }

    if (entries.length === 0) {
      seen.add(t.url);
      continue;
    }

    const eventSlug = slugify(t.title);
    const outDir = join(BASE, "output", eventSlug);
    mkdirSync(outDir, { recursive: true });

    const items: PhotoItem[] = [];
    let failures = 0;

    for (let i = 0; i < entries.length; i++) {
      const digestNumber = i + 1;
      const { qa, person } = entries[i];
      try {
        const quote = await translateForCard(qa.answer, ANSWER_SOURCE_CAP, QUOTE_DISPLAY_CAP);
        await sleep(TRANSLATE_DELAY_MS);
        const translatedQuestion = await translateForCard(qa.question, QUESTION_SOURCE_CAP, CONTEXT_DISPLAY_CAP + 20);
        await sleep(TRANSLATE_DELAY_MS);
        const context = buildContext(translatedQuestion);

        const data = {
          context,
          quote,
          name: person.name,
          role: person.role,
          isDriver: person.isDriver,
          team: person.team,
          handle: HANDLE,
          portrait: person.portrait,
          background: backgroundFor(person.team, digestNumber),
        };
        const dataBlock = "const DATA = " + JSON.stringify(data) + ";";
        const src = templateSrc.replace(/const DATA = \{[\s\S]*?\};/, dataBlock);

        const fileName = `${String(digestNumber).padStart(3, "0")}-${slugify(person.name)}.png`;
        const outPath = join(outDir, fileName);
        await renderCardPuppeteer(src, TEMPLATES_DIR, outPath);

        items.push({ path: outPath, caption: `${person.name} (${person.team})\n${quote}` });
        console.log(`  [${digestNumber}/${entries.length}] ${fileName} rendered`);
      } catch (e) {
        failures++;
        console.error(`  [${digestNumber}/${entries.length}] failed, skipping: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (items.length > 0) {
      try {
        await sendTelegramMessage(token, chatId, `🏁 *${t.title}*\n${items.length} story(ies)${failures ? ` (${failures} échec(s))` : ""} — ${t.url}`);
        await sendPhotosInBatches(token, chatId, items);
        console.log(`  sent ${items.length} photo(s) to Telegram`);
        seen.add(t.url);
      } catch (e) {
        console.error(`  Telegram send failed, will retry next run: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.log(`  nothing renderable, marking seen anyway`);
      seen.add(t.url);
    }

    rmSync(outDir, { recursive: true, force: true });
  }

  saveSeen(seen);
  await closeBrowser();
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
