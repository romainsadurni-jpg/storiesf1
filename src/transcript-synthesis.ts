// Condenses parsed FIA transcript Q&A pairs (English, full paragraphs) into
// card-ready French text: a short context line (from the question) and a
// short punchy quote (condensed/translated from the answer). Same LLM
// plumbing as synthesis.ts (Ollama locally, Anthropic if configured) but a
// different job — synthesis.ts keeps WTTS quotes verbatim in English for an
// editorial text product; a story card is French, visual, and short, so this
// one deliberately paraphrases/translates rather than lifting verbatim.
//
// Two-pass extraction: a single LLM call asked to "translate and pick the
// best line" from a long, multi-topic answer tends to just paraphrase
// whatever it read first rather than genuinely comparing options (verified
// by hand on 7B local output). So this splits the job: pass 1 extracts 1-3
// distinct candidate quotes per answer (different passages, not rewordings
// of each other); pass 2 is a separate "editor" call that only sees the
// candidates side by side and picks/polishes the one with the most impact.

import { resolveProvider, type Provider } from "./synthesis";
import type { TranscriptQA } from "./transcript";
import { allKnownSurnames } from "./asset-manifest";

export type CardText = { context: string; quote: string };

const EXTRACT_SYSTEM_PROMPT = `Tu es l'assistant éditorial du compte Instagram/TikTok F1 @SaD_F1. On te donne une liste de paires question/réponse tirées d'une conférence de presse FIA (en anglais). Pour CHAQUE paire, décide d'abord si c'est une VRAIE question de fond avec une VRAIE réponse de fond, puis repère les meilleurs passages possibles pour une citation.

RÈGLE ANTI-INVENTION, LA PLUS IMPORTANTE : chaque paire a son propre champ "speaker" — c'est TOUJOURS cette personne, et UNIQUEMENT elle, qui parle dans cette paire précise, même si une autre paire de la même liste concerne quelqu'un d'autre. Ne nomme JAMAIS dans "context" une autre personne que le "speaker" de la paire en cours (sauf si un autre nom est cité textuellement DANS la question ou la réponse de CETTE paire). Ne mentionne JAMAIS un lieu, un circuit, un événement ou un chiffre qui n'apparaît pas mot pour mot dans la question ou la réponse fournies — si un détail te manque, reste plus vague plutôt que de deviner ou de compléter avec tes propres connaissances F1.

- "real" (booléen) : false si la "question" n'en est pas vraiment une (une simple relance du modérateur, un remerciement, une transition du style "Okay, merci, on passe à X", des félicitations sans sujet, une blagounette entre pilotes) OU si la "réponse" ne dit rien de fond (un simple "oui"/"non"/"ça n'a pas d'importance"/"je peux y aller ?" sans développement). true dès que la question porte sur un vrai sujet (course, stratégie, avenir, polémique, ressenti, résultat, décision...) ET que la réponse développe une vraie idée, même courte. Base ce jugement sur le CONTENU, pas sur la longueur du texte ni sur des tournures figées.
- "context" (uniquement si "real": true) : une phrase courte (80 caractères max si possible, 110 grand maximum) qui pose la situation à partir de la QUESTION, façon légende de story sportive — jamais "Le journaliste demande...", jamais une reformulation neutre. Va droit au sujet et finis par ":" pour introduire la citation. Exemples de ton : "Sur son avenir chez Red Bull, Verstappen botte en touche :" / "Interrogé sur les fiançailles de Russell, l'ambiance est légère :".
- "candidates" (uniquement si "real": true) : de 1 à 3 citations CANDIDATES tirées de DIFFÉRENTS passages de la réponse — si la réponse aborde plusieurs idées, prends des passages différents (pas trois reformulations du même bout de phrase). Un seul candidat suffit si la réponse ne développe vraiment qu'une seule idée. Chaque candidat : {"quote": "adapté en français fluide, fidèle au sens, environ 100 à 220 caractères — NE COUPE PAS à la première phrase venue : garde les détails concrets qui donnent du poids à la citation (le chiffre, le nom cité, la comparaison, la raison invoquée, la nuance), pas juste une punchline isolée sans contexte. Un pilote qui explique POURQUOI, avec quel détail, vaut mieux qu'un 'oui c'est positif' tout sec. Sentence case, jamais de majuscules, pas de guillemets autour, TOUJOURS en français, jamais un mot d'anglais laissé tel quel", "why": "en quelques mots, ce qui rend CE passage intéressant pour une story visuelle : humour, aveu, image forte, chiffre choc, tension, émotion brute... sert à faire varier les candidats, pas à les classer toi-même"}.

Quand "real" est false, mets "context" à "" et "candidates" à [].

Réponds UNIQUEMENT avec un objet JSON de la forme {"results": [...]}, un élément du tableau "results" par paire fournie, dans le même ordre, sans texte autour, sans bloc de code :
{"results": [{"real": true, "context": "...", "candidates": [{"quote": "...", "why": "..."}]}, ...]}`;

const JUDGE_SYSTEM_PROMPT = `Tu es le rédacteur en chef du compte Instagram/TikTok F1 @SaD_F1. On te donne une liste d'items : chacun a le contexte d'une story et plusieurs citations CANDIDATES déjà condensées en français, tirées de passages différents de la même réponse d'interview. Pour CHAQUE item, choisis la citation qui fera la MEILLEURE story visuelle — préfère l'humain, la punchline, l'aveu surprenant, l'émotion brute ou l'image forte à une réponse plate, générique ou purement factuelle. Ne pénalise pas un candidat pour sa longueur : une citation d'environ 100 à 220 caractères qui garde un détail concret (chiffre, nom, comparaison, raison invoquée) est PRÉFÉRABLE à une punchline coupée trop court qui perd la substance. Tu peux légèrement polir le texte choisi (fluidité, léger ajustement de longueur) mais sans changer le sens ni ajouter un contenu absent des candidats fournis, et sans le réduire à une bribe. Toujours en français, sentence case, sans guillemets autour.

Réponds UNIQUEMENT avec un objet JSON de la forme {"results": [...]}, un élément par item fourni, dans le même ordre, sans texte autour, sans bloc de code :
{"results": [{"quote": "..."}, ...]}`;

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:latest";

async function callLlm(systemPrompt: string, prompt: string): Promise<string> {
  const provider = resolveProvider();
  if (provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
    const msg = await client.messages.create({
      model,
      max_tokens: 2000,
      temperature: 0.3,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
    });
    const block = msg.content.find((b) => b.type === "text");
    return block && "text" in block ? block.text : "";
  }

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0.3, num_predict: 2000 },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

function extractResultsArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Réponse non-JSON du modèle");
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as { results?: unknown };
  if (!Array.isArray(parsed.results)) throw new Error('Champ "results" absent ou non-tableau');
  return parsed.results;
}

function nullableString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Small batches keep the prompt within a 7B local model's comfortable
// context and bound the damage of one malformed JSON response — a failed
// batch is retried once and, on a second failure, skipped rather than
// blocking every other batch in the transcript. Extraction uses a smaller
// batch than judging: it's the pass that names the speaker, and a crowded
// 6-item batch measurably increased cross-item "bleed" (item 7's context
// naming item 4's speaker) on the local 7B model — the judge pass never
// names anyone, so it can stay at the larger batch size.
const EXTRACT_BATCH_SIZE = 4;
const JUDGE_BATCH_SIZE = 6;
const MAX_ATTEMPTS = 2;

function concurrencyFor(provider: Provider): number {
  return provider === "ollama" ? 1 : 3;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Core English function words that essentially never appear in French prose
// — a cheap, language-detection-free way to catch the odd batch where the
// local model answered in English despite the system prompt (observed with
// qwen2.5:7b under load). Checked on the actual output text, not on any
// fixed phrase list from the source transcript.
const ENGLISH_LEAK_RE = /\b(the|and|was|were|you|your|don't|didn't|wasn't|isn't|it's|with|really|going to|for|is|so|have|has|this|that|what|know|think|life)\b/i;

function looksEnglish(text: string): boolean {
  return ENGLISH_LEAK_RE.test(text);
}

// ---- Pass 1: extraction (real/not-real filter + candidate quotes) --------

type Candidate = { quote: string; why: string };
type ExtractionOutcome =
  | { kind: "ok"; context: string; candidates: Candidate[] }
  | { kind: "not-real" }
  | { kind: "invalid" };

function normalizeForMatch(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Every known driver/principal surname, computed once — checked against
// each item's own source text below rather than filtered up front, since
// "known but absent from this particular Q&A" is exactly what makes a
// mention suspicious.
const ALL_SURNAMES = allKnownSurnames();

function containsWord(haystack: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(haystack);
}

/** True if `text` names a rostered driver/principal who is neither the
 * actual speaker nor mentioned anywhere in the source question/answer —
 * catches two distinct failure modes seen with the local 7B model: another
 * item's speaker "bleeding" into this one on a crowded batch, and a name
 * invented from the model's own F1 knowledge (e.g. "Liam Sargeant" when the
 * source only ever said "Liam"). A surname that genuinely appears in the
 * source text (even attached to a bare first name there) is left alone. */
function mentionsInventedPerson(text: string, qa: TranscriptQA): boolean {
  const normalizedText = normalizeForMatch(text);
  const normalizedSource = normalizeForMatch(`${qa.question} ${qa.answer}`);
  const ownKey = normalizeForMatch(qa.speaker);
  return ALL_SURNAMES.some(
    (surname) =>
      surname.length > 2 &&
      !ownKey.includes(surname) &&
      containsWord(normalizedText, surname) &&
      !containsWord(normalizedSource, surname),
  );
}

function parseExtractionItem(p: Record<string, unknown>, qa: TranscriptQA): ExtractionOutcome {
  if (p.real !== true) return { kind: "not-real" };
  const context = nullableString(p.context);
  const rawCandidates = Array.isArray(p.candidates) ? (p.candidates as Record<string, unknown>[]) : [];
  const candidates = rawCandidates
    .map((c) => ({ quote: nullableString(c.quote), why: nullableString(c.why) }))
    .filter((c) => c.quote.length > 0);
  if (!context || candidates.length === 0) return { kind: "invalid" };
  if (looksEnglish(context) || candidates.some((c) => looksEnglish(c.quote))) return { kind: "invalid" };
  if (mentionsInventedPerson(context, qa) || candidates.some((c) => mentionsInventedPerson(c.quote, qa))) {
    return { kind: "invalid" };
  }
  return { kind: "ok", context, candidates };
}

async function extractBatch(batch: TranscriptQA[]): Promise<ExtractionOutcome[]> {
  const prompt = JSON.stringify(
    batch.map((qa) => ({ speaker: qa.speaker, question: qa.question, answer: qa.answer })),
  );

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await callLlm(EXTRACT_SYSTEM_PROMPT, prompt);
      const parsed = extractResultsArray(raw);
      if (parsed.length !== batch.length) {
        throw new Error(`Attendu ${batch.length} entrées, reçu ${parsed.length}`);
      }
      return (parsed as Record<string, unknown>[]).map((item, i) => parseExtractionItem(item, batch[i]));
    } catch (e) {
      lastError = e;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[transcript-synthesis] extract batch attempt ${attempt} failed, retrying:`, e instanceof Error ? e.message : e);
      }
    }
  }
  console.error(`[transcript-synthesis] extract batch failed after ${MAX_ATTEMPTS} attempts:`, lastError instanceof Error ? lastError.message : lastError);
  return batch.map(() => ({ kind: "invalid" }) as ExtractionOutcome);
}

// ---- Pass 2: judge (pick the best candidate, batched) ---------------------

type JudgeInput = { context: string; candidates: Candidate[] };

async function judgeBatch(batch: JudgeInput[]): Promise<(string | null)[]> {
  const prompt = JSON.stringify(
    batch.map((item) => ({ context: item.context, candidates: item.candidates.map((c) => ({ quote: c.quote, why: c.why })) })),
  );

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await callLlm(JUDGE_SYSTEM_PROMPT, prompt);
      const parsed = extractResultsArray(raw);
      if (parsed.length !== batch.length) {
        throw new Error(`Attendu ${batch.length} entrées, reçu ${parsed.length}`);
      }
      return (parsed as Record<string, unknown>[]).map((p) => {
        const quote = nullableString(p.quote);
        return quote && !looksEnglish(quote) ? quote : null;
      });
    } catch (e) {
      lastError = e;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[transcript-synthesis] judge batch attempt ${attempt} failed, retrying:`, e instanceof Error ? e.message : e);
      }
    }
  }
  console.error(`[transcript-synthesis] judge batch failed after ${MAX_ATTEMPTS} attempts, falling back to first candidate:`, lastError instanceof Error ? lastError.message : lastError);
  return batch.map(() => null);
}

// ---- Orchestration ---------------------------------------------------------

export type SynthesisStats = { ok: number; notReal: number; failed: number };

/** Condenses every Q&A pair into card-ready French text, in two passes:
 * extraction (1-3 candidate quotes per real Q&A, batched) then judging
 * (picks/polishes the best candidate, batched separately). Exchanges the
 * model judges to be pure small talk/logistics get no card (by design, not
 * a failure). Technical misses (malformed JSON, English leaking through) at
 * the extraction stage get one individual retry. A judge-stage failure
 * falls back to the first extracted candidate rather than losing the card.
 * Returns one entry per input pair, in the same order (null wherever
 * there's no card: filtered out, or extraction failed twice). */
export async function synthesizeCardTexts(qas: TranscriptQA[]): Promise<{ texts: (CardText | null)[]; stats: SynthesisStats }> {
  if (qas.length === 0) return { texts: [], stats: { ok: 0, notReal: 0, failed: 0 } };
  const concurrency = concurrencyFor(resolveProvider());

  // Pass 1: extraction, in batches, with individual retry for technical misses.
  const extractBatches: TranscriptQA[][] = [];
  for (let i = 0; i < qas.length; i += EXTRACT_BATCH_SIZE) extractBatches.push(qas.slice(i, i + EXTRACT_BATCH_SIZE));
  const extracted = (await mapWithConcurrency(extractBatches, concurrency, extractBatch)).flat();

  const retryIndices = extracted.reduce<number[]>((acc, o, i) => (o.kind === "invalid" ? [...acc, i] : acc), []);
  if (retryIndices.length > 0) {
    const retried = await mapWithConcurrency(retryIndices, concurrency, async (i) => (await extractBatch([qas[i]]))[0]);
    retryIndices.forEach((i, j) => (extracted[i] = retried[j]));
  }

  const stats: SynthesisStats = { ok: 0, notReal: 0, failed: 0 };
  const texts: (CardText | null)[] = new Array(extracted.length).fill(null);

  // Single-candidate extractions skip the judge call entirely — nothing to compare.
  const judgeIndices: number[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const o = extracted[i];
    if (o.kind === "not-real") { stats.notReal++; continue; }
    if (o.kind === "invalid") { stats.failed++; continue; }
    if (o.candidates.length === 1) {
      texts[i] = { context: o.context, quote: o.candidates[0].quote };
      stats.ok++;
    } else {
      judgeIndices.push(i);
    }
  }

  // Pass 2: judge, in batches, over every multi-candidate extraction.
  if (judgeIndices.length > 0) {
    const judgeInputs = judgeIndices.map((i) => {
      const o = extracted[i] as Extract<ExtractionOutcome, { kind: "ok" }>;
      return { context: o.context, candidates: o.candidates };
    });
    const judgeBatches: JudgeInput[][] = [];
    for (let i = 0; i < judgeInputs.length; i += JUDGE_BATCH_SIZE) judgeBatches.push(judgeInputs.slice(i, i + JUDGE_BATCH_SIZE));
    const judged = (await mapWithConcurrency(judgeBatches, concurrency, judgeBatch)).flat();

    judgeIndices.forEach((i, j) => {
      const o = extracted[i] as Extract<ExtractionOutcome, { kind: "ok" }>;
      const chosen = judged[j] ?? o.candidates[0].quote; // judge failed twice -> fall back rather than drop the card
      texts[i] = { context: o.context, quote: chosen };
      stats.ok++;
    });
  }

  return { texts, stats };
}
