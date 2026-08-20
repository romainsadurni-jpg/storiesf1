// Turns one FIA press-conference transcript URL into a batch of quote-card
// story PNGs — one per Q&A pair whose speaker is a known driver/principal.
// Usage: npx tsx scripts/gen_stories_from_transcript.ts <transcript-url> [output-subdir]
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
import { extractContentBodyHtml, parseTranscriptBody, type TranscriptQA } from "../src/transcript";
import { resolvePerson, backgroundFor } from "../src/asset-manifest";
import { synthesizeCardTexts } from "../src/transcript-synthesis";

const BASE = join(__dirname, "..");
const TEMPLATE_PATH = join(BASE, "templates", "quote-card.html");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HANDLE = "@SaD_F1";

const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; F1-Stories-Generator/1.0)" };

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
  eligible: { qa: TranscriptQA; person: NonNullable<ReturnType<typeof resolvePerson>> }[],
  cardTexts: (import("../src/transcript-synthesis").CardText | null)[],
): void {
  const lines: string[] = [];
  let n = 0;
  for (let i = 0; i < eligible.length; i++) {
    const text = cardTexts[i];
    if (!text) continue;
    const { qa, person } = eligible[i];
    n++;
    lines.push(`## ${n}. ${person.name} (${person.team})`);
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
  console.log(`Dump texte écrit dans ${path} (${n} entrées).`);
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npx tsx scripts/gen_stories_from_transcript.ts <transcript-url> [output-subdir] [--no-render]");
    process.exit(1);
  }
  const noRender = process.argv.includes("--no-render");

  console.log(`Fetching ${url} ...`);
  const pageHtml = await fetchTranscriptHtml(url);
  const bodyHtml = extractContentBodyHtml(pageHtml);
  if (!bodyHtml) throw new Error("content-body introuvable sur cette page");

  const qas = parseTranscriptBody(bodyHtml);
  console.log(`${qas.length} paires Q/R extraites.`);

  const eligible: { qa: TranscriptQA; person: NonNullable<ReturnType<typeof resolvePerson>> }[] = [];
  for (const qa of qas) {
    const person = resolvePerson(qa.speaker);
    if (person) eligible.push({ qa, person });
  }
  const skipped = qas.length - eligible.length;
  console.log(`${eligible.length} avec un intervenant reconnu (portrait dispo)${skipped ? `, ${skipped} ignorées (inconnu du manifest)` : ""}.`);

  console.log("Condensation FR (LLM) ...");
  const { texts: cardTexts, stats } = await synthesizeCardTexts(eligible.map((e) => e.qa));
  console.log(`${stats.ok} retenues, ${stats.notReal} écartées (pas une vraie question/réponse de fond), ${stats.failed} échecs techniques.`);

  const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  const outSubdir = positional[0] ?? slugify(new URL(url).pathname.replace(/^\/news\//, ""));
  const outDir = join(BASE, "output", outSubdir);
  mkdirSync(outDir, { recursive: true });

  writeTextDump(outDir, eligible, cardTexts);

  if (noRender) return;

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
      background: backgroundFor(person.team, i),
    };

    const fileName = `${String(i + 1).padStart(3, "0")}-${slugify(person.name)}.png`;
    const outPath = join(outDir, fileName);
    renderCard(templateSrc, data, outPath);
    written++;
    console.log(`  [${written}] ${fileName} — ${qa.speaker}: "${text.quote.slice(0, 60)}${text.quote.length > 60 ? "…" : ""}"`);
  }

  console.log(`\n${written} stories générées dans output/${outSubdir}/.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
