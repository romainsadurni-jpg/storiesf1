// Condenses one press article (Articles tab) into quote-card.html data —
// same LLM-condensation idea as transcript-synthesis.ts (Q/A -> FR
// context+quote), but the source here is a single-subject news article
// instead of a press-conference Q/A pair, so the model has to find its own
// "quote" (a real quote-marked declaration if the article has one for the
// subject, otherwise a faithful one-line paraphrase of the key fact) rather
// than condense an already-isolated answer.
//
// The article's title is the throughline: it's read as the question the
// reader wants answered, and "context"/"quote" are asked to be exactly the
// elements of the full text that answer it — not a generic summary of the
// whole piece.

import { resolveProvider, type Provider } from "./synthesis";

export type ArticleCardText = {
  /** Name exactly as it appears in the article — a person if the article
   * centers on one, otherwise the team/organization it's primarily about.
   * Matched against assets/manifest.json / teams.ts by the caller
   * (server.ts's resolveSubject), not here, so this module stays free of
   * the roster's specifics. Never null — every article gets a card, see
   * generateArticleStory() in server.ts, which only skips on a genuine
   * technical failure (fetch/LLM), never for an unlisted subject. */
  subjectName: string;
  context: string;
  quote: string;
  /** True when `quote` is lifted (near-)verbatim from a quote-marked
   * passage attributed to the subject; false when the model had to
   * paraphrase the key fact instead (no usable quote in the text). */
  verbatim: boolean;
};

const SYSTEM_PROMPT = `Tu es un assistant éditorial qui prépare des "story cards" verticales (façon story Instagram) à partir d'articles de presse Formule 1.

On te donne le TITRE d'un article et son TEXTE INTÉGRAL. Le titre pose un sujet ou une question implicite ; ton travail est de repérer, DANS LE TEXTE, les éléments qui répondent précisément à ce titre — pas de résumer tout l'article.

Le texte source est presque toujours en anglais — ta réponse, elle, ne doit JAMAIS l'être : "context" et "quote" sont TOUJOURS rédigés en français, intégralement, sans laisser un seul mot ou une seule expression en anglais. Traduire fidèlement fait partie du travail, pas une option.

Étapes :
1. Identifie le SUJET PRINCIPAL de l'article — celui à qui le titre se rapporte le plus directement. C'est presque toujours une personne (pilote, dirigeant d'écurie, patron de team) ; donne alors son nom complet EXACTEMENT comme il apparaît dans le texte. Si vraiment aucune personne précise n'est le sujet central (article institutionnel, business, décision FIA...), utilise à la place le nom de l'écurie ou de l'organisation dont parle l'article (ex: "Aston Martin", "FIA", "Red Bull"). Il y a TOUJOURS un sujet à donner — ne réponds jamais null, choisis le nom propre le plus central au texte. Ce nom-là reste tel quel — ne le traduis pas.
2. "context" : UNE phrase courte, EN FRANÇAIS, qui pose la situation évoquée par le titre (le "avant" ou le cadre), sans guillemets, factuelle, jamais inventée au-delà de ce que dit le texte.
3. "quote" :
   - Si le texte contient une citation entre guillemets attribuée à ce sujet et qui répond bien au sujet du titre, traduis-la fidèlement EN FRANÇAIS (même si l'original est en anglais — ne recopie jamais l'anglais tel quel) et mets "verbatim": true.
   - Sinon, condense en UNE phrase percutante, EN FRANÇAIS, le fait principal du texte qui répond au titre (jamais une citation inventée, une vraie paraphrase factuelle) et mets "verbatim": false.

RAPPEL avant de répondre : "context" et "quote" sont entièrement en français. Aucune trace d'anglais dans ces deux champs. "subjectName" n'est jamais null.

Réponds UNIQUEMENT avec ce JSON, sans texte autour, sans bloc de code :
{"subjectName": "...", "context": "...", "quote": "...", "verbatim": true | false}`;

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:latest";

async function callLlm(prompt: string): Promise<string> {
  const provider = resolveProvider();
  if (provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
    const msg = await client.messages.create({
      model,
      max_tokens: 1000,
      temperature: 0.1,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
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
      options: { temperature: 0.1, num_predict: 1000 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Réponse non-JSON du modèle");
  return JSON.parse(candidate.slice(start, end + 1));
}

// Real article text runs a few thousand chars typically, but a long-form
// piece (The Race's analysis pieces, seen in the Articles tab, regularly
// run 4000-8000 chars) needs headroom above that — same reasoning as
// article-fetcher's own MAX_CHARS, just scoped to what fits a single-subject
// extraction prompt instead of an 11-team article.
const MAX_TEXT_CHARS = 12000;

const MAX_ATTEMPTS = 3;

// Weaker local models (qwen2.5:7b in practice) reliably translate the short
// "context" sentence but sometimes leave a long/dense "quote" in the
// source's original English despite the prompt's repeated instruction —
// observed live: a weather-forecast quote and an investment-deal quote both
// came back untranslated while their context translated fine. A whole-word
// count of common English function words catches this (a genuine French
// sentence essentially never contains several of "the/and/is/with/have...",
// short strings are exempt since one stray match on a short text is noise).
const ENGLISH_TELLS = /\b(the|and|is|are|was|were|with|have|has|this|that|from|will|their|its|about|which|been|were|per\s?cent)\b/gi;

function looksEnglish(text: string): boolean {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 6) return false;
  const hits = text.match(ENGLISH_TELLS)?.length ?? 0;
  return hits / wordCount > 0.12;
}

/** Returns null only when every attempt failed outright (fetch already
 * happened — this is purely the LLM step) — every article gets a subject
 * per the prompt, so there's no "no subject" skip case to speak of anymore. */
export async function synthesizeArticleCard(title: string, fullText: string): Promise<ArticleCardText | null> {
  if (resolveProvider() === "none") {
    throw new Error("Aucun provider LLM configuré (ANTHROPIC_API_KEY ou OLLAMA_BASE_URL/OLLAMA_MODEL)");
  }

  const basePrompt = `Titre : ${title}\n\nTexte intégral :\n${fullText.slice(0, MAX_TEXT_CHARS)}\n\nRéponds uniquement avec le JSON demandé.`;
  const correctionSuffix = `\n\nATTENTION : ta réponse précédente contenait encore de l'anglais dans "context" et/ou "quote". Cette fois, traduis INTÉGRALEMENT ces deux champs en français — pas un seul mot d'anglais, même dans une citation longue ou technique (chiffres, unités, heures : garde-les, mais le reste du texte autour est en français).`;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = attempt === 1 ? basePrompt : basePrompt + correctionSuffix;
    try {
      const raw = await callLlm(prompt);
      const parsed = extractJson(raw) as {
        subjectName?: unknown;
        context?: unknown;
        quote?: unknown;
        verbatim?: unknown;
      };
      const subjectName = typeof parsed.subjectName === "string" ? parsed.subjectName.trim() : "";
      const context = typeof parsed.context === "string" ? parsed.context.trim() : "";
      const quote = typeof parsed.quote === "string" ? parsed.quote.trim() : "";
      if (!subjectName || !context || !quote) throw new Error("champ manquant dans la réponse du modèle");
      if (looksEnglish(context) || looksEnglish(quote)) throw new Error("réponse encore en anglais");
      return { subjectName, context, quote, verbatim: parsed.verbatim === true };
    } catch (e) {
      lastError = e;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[article-synthesis] attempt ${attempt} failed, retrying:`, e instanceof Error ? e.message : e);
      }
    }
  }
  console.error(`[article-synthesis] LLM failed after ${MAX_ATTEMPTS} attempts:`, lastError instanceof Error ? lastError.message : lastError);
  return null;
}

export type { Provider };
