// Turns one FIA press-conference transcript URL into a batch of quote-card
// story PNGs — one per Q&A pair whose speaker is a known driver/principal.
// Usage: npx tsx scripts/gen_stories_from_transcript.ts <transcript-url> [output-subdir] [--pick 3,7,12] [--no-telegram]
//
// --pick takes the numbers straight off a Telegram digest message (sent by
// scripts/cloud-digest.ts): both scripts derive their list from the same
// src/digest.ts eligibleEntries(), in the same order, so "digest said #3
// and #7" maps directly to --pick 3,7 without re-deriving anything by hand.
// Omit --pick to generate cards for every eligible pair in the transcript.
//
// Each rendered PNG is sent straight to Telegram (TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID from .env) as soon as it's rendered, so the finished
// story lands on the phone without digging through output/ — pass
// --no-telegram to skip that and just write the files locally.
//
// Pipeline: fetch → parse (transcript.ts, deterministic) → resolve speaker
// to a manifest portrait (asset-manifest.ts) → condense to FR context+quote
// (transcript-synthesis.ts, LLM) → render quote-card.html per pair via
// headless Chrome, same technique as gen_quotes_hungary.py but driven by
// data instead of hand-typed entries.

import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractContentBodyHtml, parseTranscriptBody } from "../src/transcript";
import { backgroundFor } from "../src/asset-manifest";
import { eligibleEntries, type EligibleEntry } from "../src/digest";
import { synthesizeCardTexts } from "../src/transcript-synthesis";

const BASE = join(__dirname, "..");
const TEMPLATE_PATH = join(BASE, "templates", "quote-card.html");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HANDLE = "@SaD_F1";

const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)" };

async function sendTelegramPhoto(token: string, chatId: string, filePath: string, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("photo", new Blob([readFileSync(filePath)], { type: "image/png" }), filePath.split(/[\\/]/).pop());
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendPhoto failed: ${data.description ?? res.status}`);
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents (é -> e) before stripping non-alnum, else "Pérez" -> "p-rez"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchTranscriptHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

type CardData = {
  context: string;
  quote: string;
  name: string;
  role: string;
  isDriver: boolean;
  team: string;
  handle: string;
  portrait: string;
  background: string;
};

function renderCard(templateSrc: string, data: CardData, outPath: string): void {
  const dataBlock = "const DATA = " + JSON.stringify(data) + ";";
  const src = templateSrc.replace(/const DATA = \{[\s\S]*?\};/, dataBlock);

  const tmpPath = join(BASE, "templates", `_tmp_${slugify(data.name)}_${Date.now()}.html`);
  writeFileSync(tmpPath, src, "utf-8");
  try {
    execFileSync(CHROME, [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1080,1920",
      `--screenshot=${outPath}`,
      `file:///${tmpPath.replace(/\\/g, "/")}`,
    ]);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

function writeTextDump(
  outDir: string,
  eligible: EligibleEntry[],
  cardTexts: (import("../src/transcript-synthesis").CardText | null)[],
  digestNumbers: number[],
): void {
  const lines: string[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const text = cardTexts[i];
    if (!text) continue;
    const { qa, person } = eligible[i];
    lines.push(`## ${digestNumbers[i]}. ${person.name} (${person.team})`);
    lines.push("");
    lines.push(`**Question (source, EN) :** ${qa.question}`);
    lines.push(`**Réponse (source, EN) :** ${qa.answer}`);
    lines.push("");
    lines.push(`**Contexte (FR) :** ${text.context}`);
    lines.push(`**Citation (FR) :** ${text.quote}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  const path = join(outDir, "stories.md");
  writeFileSync(path, lines.join("\n"), "utf-8");
  const written = cardTexts.filter((t) => t !== null).length;
  console.log(`Dump texte écrit dans ${path} (${written} entrées).`);
}

function parsePickArg(argv: string[]): number[] | null {
  const idx = argv.indexOf("--pick");
  if (idx === -1) return null;
  const raw = argv[idx + 1];
  if (!raw) throw new Error("--pick requiert une liste d'indices, ex: --pick 3,7,12");
  return raw.split(",").map((s) => {
    const n = parseInt(s.trim(), 10);
    if (!Number.isInteger(n) || n < 1) throw new Error(`Indice invalide dans --pick: "${s}"`);
    return n;
  });
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npx tsx scripts/gen_stories_from_transcript.ts <transcript-url> [output-subdir] [--pick 3,7,12] [--no-render]");
    process.exit(1);
  }
  const noRender = process.argv.includes("--no-render");
  const pick = parsePickArg(process.argv);

  console.log(`Fetching ${url} ...`);
  const pageHtml = await fetchTranscriptHtml(url);
  const bodyHtml = extractContentBodyHtml(pageHtml);
  if (!bodyHtml) throw new Error("content-body introuvable sur cette page");

  const qas = parseTranscriptBody(bodyHtml);
  console.log(`${qas.length} paires Q/R extraites.`);

  const allEligible = eligibleEntries(qas);
  console.log(`${allEligible.length} paires éligibles (même numérotation que le digest Telegram).`);

  let eligible: EligibleEntry[];
  let digestNumbers: number[];
  if (pick) {
    const invalid = pick.filter((n) => n > allEligible.length);
    if (invalid.length > 0) {
      throw new Error(`Indice(s) hors limites (max ${allEligible.length}): ${invalid.join(", ")}`);
    }
    eligible = pick.map((n) => allEligible[n - 1]);
    digestNumbers = pick;
    console.log(`--pick appliqué : ${pick.join(", ")} (${eligible.length} carte(s) sélectionnée(s)).`);
  } else {
    eligible = allEligible;
    digestNumbers = allEligible.map((_, i) => i + 1);
  }

  console.log("Condensation FR (LLM) ...");
  const { texts: cardTexts, stats } = await synthesizeCardTexts(eligible.map((e) => e.qa));
  console.log(`${stats.ok} retenues, ${stats.notReal} écartées (pas une vraie question/réponse de fond), ${stats.failed} échecs techniques.`);

  const positional = process.argv.slice(3).filter((a, i, arr) => !a.startsWith("--") && arr[i - 1] !== "--pick");
  const outSubdir = positional[0] ?? slugify(new URL(url).pathname.replace(/^\/news\//, ""));
  const outDir = join(BASE, "output", outSubdir);
  mkdirSync(outDir, { recursive: true });

  writeTextDump(outDir, eligible, cardTexts, digestNumbers);

  if (noRender) return;

  const noTelegram = process.argv.includes("--no-telegram");
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  const sendToTelegram = !noTelegram && !!tgToken && !!tgChatId;
  if (!noTelegram && !sendToTelegram) {
    console.warn("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID absents de .env — cartes générées localement seulement.");
  }

  const templateSrc = readFileSync(TEMPLATE_PATH, "utf-8");

  let written = 0;
  for (let i = 0; i < eligible.length; i++) {
    const text = cardTexts[i];
    if (!text) continue;
    const { qa, person } = eligible[i];

    const data: CardData = {
      context: text.context,
      quote: text.quote,
      name: person.name,
      role: person.role,
      isDriver: person.isDriver,
      team: person.team,
      handle: HANDLE,
      portrait: person.portrait,
      background: backgroundFor(person.team, digestNumbers[i]),
    };

    const fileName = `${String(digestNumbers[i]).padStart(3, "0")}-${slugify(person.name)}.png`;
    const outPath = join(outDir, fileName);
    renderCard(templateSrc, data, outPath);
    written++;
    console.log(`  [${written}] ${fileName} — ${qa.speaker}: "${text.quote.slice(0, 60)}${text.quote.length > 60 ? "…" : ""}"`);

    if (sendToTelegram) {
      try {
        const caption = `${person.name} (${person.team})\n${text.quote}`.slice(0, 1024);
        await sendTelegramPhoto(tgToken!, tgChatId!, outPath, caption);
        console.log(`      -> envoyée sur Telegram`);
      } catch (e) {
        console.error(`      -> échec envoi Telegram: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  console.log(`\n${written} stories générées dans output/${outSubdir}/.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
