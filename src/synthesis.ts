// Structured, per-team extraction from "What the teams said" articles —
// port of f1-editorial-os's lib/wtts-synthesis.ts. Same design, same
// reasoning: each team only ever sees its OWN section of the article (never
// the whole multi-team text), because a local 7B model asked to "find the
// relevant part" in a shared 10-team article just summarized whichever team
// was mentioned first for every team instead. Splitting the source before
// the model ever sees it removes that failure mode entirely.

import { TEAMS, type Team } from "./teams";

export type WttsSentiment = "positif" | "neutre" | "négatif";

export type WttsQuote = {
  /** The declaration itself — a real quotation from the text if one was
   * given between quote marks, otherwise a faithful paraphrase. */
  text: string;
  /** True when `text` is lifted (near-)verbatim from a quote-marked
   * passage; false when the model had to paraphrase unquoted reporting. */
  verbatim: boolean;
};

export type WttsSessionResult = {
  /** Exactly as named in the source text when explicit ("FP1", "FP2",
   * "FP3", "Q1", "Q2", "Q3"), otherwise the article's own session label
   * ("Qualifying", "Race day"...) for articles that only ever give one
   * result per driver. */
  session: string;
  /** Position or status only — "P1", "17th", "DNF" — never a lap time. */
  position: string;
};

export type WttsDriverFact = {
  driver: string;
  /** One entry per session this driver ran, in order — e.g. [{session:
   * "FP1", position: "P1"}, {session: "FP2", position: "P2"}] for a
   * Friday practice article. Built from this, not free-form prose, so the
   * per-driver result line (`renderResultLine` in server.ts) never depends
   * on the model getting a summary sentence right. */
  sessions: WttsSessionResult[];
  /** Every distinct declaration attributed to this driver in the section
   * (a driver quote block is often 2-3 paragraphs covering separate
   * topics), not just the first one. */
  quotes: WttsQuote[];
  problem: string | null;
  /** An on-track clash, contact, or stewards matter involving another
   * driver (e.g. "Enquête des commissaires après un accrochage avec
   * Sainz, aucune sanction"), distinct from a mechanical `problem`. */
  incident: string | null;
  /** How this driver's session compared to their team mate's, only when
   * the text draws that comparison explicitly. */
  teammateComparison: string | null;
  /** What the driver said about the next session/race, or their plan to
   * fix something, when stated. */
  outlook: string | null;
  /** Overall tone of this driver's own words — not the journalist's
   * framing of the session. */
  sentiment: WttsSentiment | null;
};

export type WttsStaffQuote = {
  name: string;
  /** Their role as given in the text (e.g. "Team Principal", "Trackside
   * Engineering Director"), sinon null si non précisé. */
  role: string | null;
  quote: string;
};

export type WttsTeamSynthesis = {
  teamSlug: string;
  teamName: string;
  /** The session this article covers (e.g. "Qualifying", "Race day",
   * "Friday"), derived deterministically from the article title —
   * identical for every team in the same article, so it's filled in by
   * synthesizeArticle() rather than by the model. */
  session: string | null;
  /** The journalist's opening narrative paragraph(s) for this team — how
   * the session actually unfolded (battles, key moments, strategy calls),
   * before any driver is quoted. Extracted near-verbatim, same as `quotes`
   * — not compressed to a one-line takeaway. */
  context: string | null;
  drivers: WttsDriverFact[];
  /** Declarations from non-driver team figures (team principal, engineering
   * director, etc.) — WTTS articles quote them almost as often as drivers,
   * and they're usually where the strategic/reliability context lives. */
  staffQuotes: WttsStaffQuote[];
  upgrade: string | null;
};

/** "What the teams said" articles are formatted as one section per team,
 * each starting with the bare team name on its own line ("McLaren\nNorris
 * recorded..."). Verified against real fetched articles across several GPs
 * in f1-editorial-os before porting here. */
export function splitByTeamSections(text: string): Map<string, string> {
  const sortedTeams = [...TEAMS].sort((a, b) => b.name.length - a.name.length);
  const namePattern = sortedTeams.map((t) => t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const headerRe = new RegExp(`(${namePattern})\\n`, "g");
  const matches = [...text.matchAll(headerRe)];

  const sections = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const team = TEAMS.find((t) => t.name === matches[i][1]);
    if (!team) continue;
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const section = text.slice(start, end).trim();
    if (section) sections.set(team.slug, section);
  }
  return sections;
}

const SYNTHESIS_SYSTEM = `Tu es un assistant éditorial F1. On te donne le texte d'un article F1.com concernant UNE écurie précise pendant une séance de Grand Prix (essais libres, qualifications ou course).

Extrait UNIQUEMENT les faits explicitement présents dans le texte, sous forme structurée et la plus complète possible. N'invente RIEN, ne déduis rien qui ne soit pas écrit : si une information n'est pas mentionnée, mets null (ou un tableau vide).

IMPORTANT : le texte source est en anglais. Garde TOUS les champs texte ("context", "quotes.text", "problem", "incident", "teammateComparison", "outlook", "staffQuotes.quote", "upgrade") dans la langue d'origine du texte, en anglais. Ne traduis JAMAIS en français, même partiellement — une traduction abîme les citations et introduit des erreurs. Seuls tes propres instructions et les noms de champs JSON sont en français ; le contenu extrait reste tel quel.

Le texte contient, dans cet ordre : un paragraphe narratif du journaliste en tout début de section, avant toute citation, qui raconte le déroulé de la séance pour cette écurie (bagarres en piste, moments clés, choix de stratégie, incidents) ; puis, pour CHAQUE personne citée, un bloc "Nom [- détails de position/temps]" suivi d'une ou plusieurs citations entre guillemets qui LUI appartiennent. La plupart des écuries ont DEUX pilotes (parfois plus, avec un pilote de réserve) — parcours le texte et traite CHAQUE bloc pilote qu'il contient, dans l'ordre, sans en sauter aucun : si tu vois deux noms de pilotes suivis chacun de leur propre citation, le JSON doit avoir deux entrées dans "drivers", pas une.

Une citation d'un non-pilote (team principal, directeur technique...) n'apparaît que si le texte la mentionne EXPLICITEMENT avec son nom — beaucoup d'articles (surtout essais libres et qualifications) n'en contiennent AUCUNE : ne force jamais son apparition. RÈGLE ANTI-INVENTION : n'ajoute une entrée à "staffQuotes" que si un nom de personne non-pilote est écrit noir sur blanc dans le texte à côté d'une citation. N'invente JAMAIS un nom à partir de tes connaissances générales sur l'écurie (ex: ne suppose pas qui est son "team principal" s'il n'est pas cité dans CE texte). Et ne réutilise JAMAIS la citation d'un pilote comme citation de quelqu'un d'autre : chaque citation appartient à la seule personne nommée juste avant elle dans le texte, jamais à deux personnes différentes.

Extrait d'abord ce paragraphe narratif d'ouverture dans "context" : recopie-le PRESQUE MOT POUR MOT, EN ANGLAIS (comme pour "quotes" — tu peux juste fusionner ses phrases si le texte source les découpe en plusieurs paragraphes). Ne le reformule pas dans tes propres mots, ne le traduis pas, ne le raccourcis pas en un résumé d'une phrase : garde le déroulé et tous les détails concrets (qui a fait quoi, dans quel ordre, avec quel résultat). Si la section ne commence pas par un paragraphe narratif (certaines écuries n'en ont pas), mets null.

Pour chaque PILOTE mentionné, extrait :
- "driver" : son nom exact
- "sessions" : liste de {"session": "...", "position": "..."} — une entrée par séance où ce pilote a un résultat mentionné, UNIQUEMENT la position/le statut (P1, 17th, DNF...), JAMAIS le temps au tour. PRIORITÉ ABSOLUE aux séances explicitement nommées dans le texte : si tu vois "FP1: 1:19.075, P1; FP2: 1:18.877, P2", ce sont DEUX séances distinctes → DEUX entrées, une pour "FP1" avec "P1", une pour "FP2" avec "P2" — ne les fusionne JAMAIS en une seule entrée et n'utilise JAMAIS un nom de séance générique (comme "Friday") quand le texte te donne des noms précis (FP1, FP2, FP3, Q1, Q2, Q3). Le nom de séance donné plus bas ("Séance de cet article") ne sert QUE de repli quand le texte ne donne qu'un seul résultat global sans le nommer (course, classement final de qualifs). Tableau vide si aucun résultat n'est mentionné pour ce pilote.
- "quotes" : la ou les déclarations attribuées à ce pilote. Le bloc de citation source est presque toujours composé de PLUSIEURS paragraphes séparés par un saut de ligne, chacun sur un sujet différent (le tour, la stratégie, le week-end à venir...) — crée UNE entrée par paragraphe, ne les fusionne jamais en un seul bloc de texte. Pour chacune :
  - "text" : le texte de ce paragraphe, quasi mot pour mot (tu peux juste retirer les guillemets qui l'entourent), sans le réécrire ni le résumer
  - "verbatim" : true dès que ce paragraphe est entouré de guillemets (" ou ") dans le texte source — c'est le cas presque à chaque fois qu'un pilote parle dans ces articles. Mets false uniquement quand tu résumes toi-même une phrase du journaliste qui n'était pas entre guillemets.
  Tableau vide si le pilote n'a aucune déclaration rapportée.
- "problem" : un souci mécanique/technique rencontré pendant la séance, sinon null
- "incident" : un accrochage, une manœuvre litigieuse, une enquête ou décision des commissaires impliquant un autre pilote, sinon null (différent de "problem", qui est mécanique)
- "teammateComparison" : si le texte compare explicitement ce pilote à son coéquipier (écart de temps, qui a été meilleur, etc.), un résumé factuel de cette comparaison, sinon null
- "outlook" : ce que le pilote dit vouloir faire/espérer pour la suite (séance suivante, reste du week-end, corrections à apporter), sinon null
- "sentiment" : le ton général des propos du pilote lui-même (pas le narratif du journaliste) — "positif", "neutre" ou "négatif" — ou null si on ne peut pas le déterminer

Pour les figures NON-PILOTES de l'écurie (team principal, directeur technique, directeur sportif...) mentionnées avec une citation, extrait "staffQuotes" : liste de {"name": "...", "role": "...", "quote": "..."} — "role" est l'intitulé donné dans le texte (ex: "Team Principal"), null si absent. Une entrée par personne citée ; si plusieurs citations distinctes de la même personne, regroupe-les dans un seul "quote" en les concaténant dans l'ordre du texte. INTERDICTION FORMELLE : un pilote déjà présent dans "drivers" ne doit JAMAIS aussi apparaître dans "staffQuotes", même avec "role": "Driver" ou similaire — chaque personne du texte va dans UNE SEULE des deux listes, jamais les deux. "staffQuotes" est réservé aux gens qui ne pilotent pas la voiture.

Pour l'écurie dans son ensemble, extrait aussi :
- "upgrade" : une évolution technique, une pièce testée ou une mise à jour mentionnée, EN ANGLAIS, sinon null

Réponds UNIQUEMENT avec ce JSON, sans texte autour, sans bloc de code :
{"context": "...", "drivers": [{"driver": "...", "sessions": [{"session": "...", "position": "..."}], "quotes": [{"text": "...", "verbatim": true}], "problem": "...", "incident": "...", "teammateComparison": "...", "outlook": "...", "sentiment": "..."}], "staffQuotes": [{"name": "...", "role": "...", "quote": "..."}], "upgrade": "..."}`;

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:latest";

export type Provider = "ollama" | "anthropic" | "none";

export function resolveProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === "ollama") return "ollama";
  if (explicit === "anthropic") return "anthropic";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) return "ollama";
  return "none";
}

async function callLlm(prompt: string): Promise<string> {
  const provider = resolveProvider();
  if (provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
    const msg = await client.messages.create({
      model,
      // Richer schema (per-driver quote arrays + staff quotes, each often
      // several hundred words verbatim) needs real headroom over the old
      // single-declaration shape. 1400 still got cut mid-string on a
      // section with a long team-principal quote (Haas/Hungary quali:
      // ~400-word Komatsu quote pushed a valid-so-far JSON response past
      // the token limit, breaking the closing brackets) — Ollama's
      // format:"json" grammar can only emit valid syntax for what it
      // actually generates, it can't rescue a response cut off mid-field.
      max_tokens: 2800,
      temperature: 0.1,
      system: [{ type: "text", text: SYNTHESIS_SYSTEM, cache_control: { type: "ephemeral" } }],
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
      options: { temperature: 0.1, num_predict: 2800 },
      messages: [
        { role: "system", content: SYNTHESIS_SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(240_000),
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

function nullableString(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

const SENTIMENTS: WttsSentiment[] = ["positif", "neutre", "négatif"];

function nullableSentiment(v: unknown): WttsSentiment | null {
  return typeof v === "string" && (SENTIMENTS as string[]).includes(v) ? (v as WttsSentiment) : null;
}

function parseQuotes(v: unknown): WttsQuote[] {
  if (!Array.isArray(v)) return [];
  return (v as Record<string, unknown>[])
    .map((q) => ({ text: nullableString(q.text) ?? "", verbatim: q.verbatim === true }))
    .filter((q) => q.text.length > 0);
}

function parseStaffQuotes(v: unknown): WttsStaffQuote[] {
  if (!Array.isArray(v)) return [];
  return (v as Record<string, unknown>[])
    .map((s) => ({
      name: typeof s.name === "string" ? s.name.trim() : "",
      role: nullableString(s.role),
      quote: nullableString(s.quote) ?? "",
    }))
    .filter((s) => s.name.length > 0 && s.quote.length > 0);
}

// A model occasionally returns slightly malformed JSON (a stray token, a
// missing comma) — usually transient, not a sign the section itself is
// unparseable. Silently dropping the team on the first failure meant a
// real section (confirmed present via splitByTeamSections) just vanished
// from the result with no indication why. The richer schema gives the
// model more ways to stumble (nested quote arrays, an extra staffQuotes
// list), so this gets one extra retry over the original single-field
// schema; a final failure is logged and the team is skipped rather than
// blocking the rest of the article.
const MAX_ATTEMPTS = 3;

// Real team sections run ~2000-6000 chars for a typical article, but a
// headline result (a win, a DNF with drama) pulls in extra driver + team
// principal quotes and can push past 6000 — the old cap silently cut a
// team's staff quote or last driver off mid-sentence. 12000 gives real
// headroom above the observed max while still bounding a runaway section.
const MAX_SECTION_CHARS = 12000;

function parseSessions(v: unknown): WttsSessionResult[] {
  if (!Array.isArray(v)) return [];
  return (v as Record<string, unknown>[])
    .map((s) => ({ session: nullableString(s.session) ?? "", position: nullableString(s.position) ?? "" }))
    .filter((s) => s.session.length > 0 && s.position.length > 0);
}

async function synthesizeTeamSection(
  team: Team,
  sectionText: string,
  session: string | null,
): Promise<Omit<WttsTeamSynthesis, "session"> | null> {
  const sessionHint = session
    ? `Séance de cet article : ${session} (utilise ce nom pour "sessions.session" quand le texte ne donne qu'un seul résultat par pilote, sans séance explicite comme FP1/FP2).\n\n`
    : "";
  const prompt = `Écurie : ${team.name}\n\n${sessionHint}Texte de l'article :\n${sectionText.slice(0, MAX_SECTION_CHARS)}\n\nRéponds uniquement avec le JSON demandé.`;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await callLlm(prompt);
      const parsed = extractJson(raw) as {
        context?: unknown;
        drivers?: unknown;
        staffQuotes?: unknown;
        upgrade?: unknown;
      };
      const drivers: WttsDriverFact[] = Array.isArray(parsed.drivers)
        ? (parsed.drivers as Record<string, unknown>[])
            .map((d) => ({
              driver: typeof d.driver === "string" ? d.driver.trim() : "",
              sessions: parseSessions(d.sessions),
              quotes: parseQuotes(d.quotes),
              problem: nullableString(d.problem),
              incident: nullableString(d.incident),
              teammateComparison: nullableString(d.teammateComparison),
              outlook: nullableString(d.outlook),
              sentiment: nullableSentiment(d.sentiment),
            }))
            .filter((d) => d.driver.length > 0)
        : [];
      // Belt-and-braces against the model occasionally also listing a
      // driver in staffQuotes (seen with role: "Driver", duplicating their
      // own quote) despite the prompt forbidding it — dropped here
      // deterministically rather than trusted to prompt compliance alone.
      const driverNames = new Set(drivers.map((d) => d.driver.toLowerCase()));
      const staffQuotes = parseStaffQuotes(parsed.staffQuotes).filter((s) => !driverNames.has(s.name.toLowerCase()));
      return {
        teamSlug: team.slug,
        teamName: team.name,
        context: nullableString(parsed.context),
        drivers,
        staffQuotes,
        upgrade: nullableString(parsed.upgrade),
      };
    } catch (e) {
      lastError = e;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `[synthesis] attempt ${attempt} failed for ${team.name}, retrying:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
  {
    const e = lastError;
    console.error(`[synthesis] LLM failed for ${team.name} after ${MAX_ATTEMPTS} attempts:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// Anthropic's API handles real concurrent requests fine, but a single
// local Ollama instance sharing one GPU/CPU across "concurrent" requests
// has been observed to produce malformed JSON under load that the exact
// same section generates correctly in isolation (same prompt, same model,
// same low temperature — reproduced on Alpine/Hungary-qualifying: 2/2
// concurrent attempts failed at the identical byte offset, then a
// standalone call succeeded). Serializing local requests trades sync
// speed for not silently losing a team.
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

// F1.com titles this article "What the teams said – <Session> in <Location>"
// (e.g. "– Friday in Hungary", "– Qualifying in Hungary", "– Race day in
// Hungary") — the session name sits between the dash and " in ", so it's
// read straight off the title rather than asked of the model: identical
// for every team in one article, free, and never hallucinated.
export function deriveSessionLabel(articleTitle: string | null | undefined): string | null {
  if (!articleTitle) return null;
  const m = articleTitle.match(/[–—-]\s*(.+?)\s+in\s+\S/i);
  return m ? m[1].trim() : null;
}

/** Splits an article's full text by team and runs the extraction for each
 * team section found, with limited concurrency. `articleTitle` (when given)
 * is used only to derive the session label attached to every team. */
export async function synthesizeArticle(fullText: string, articleTitle?: string | null): Promise<WttsTeamSynthesis[]> {
  const sections = splitByTeamSections(fullText);
  if (sections.size === 0) return [];

  const session = deriveSessionLabel(articleTitle);
  const entries = [...sections.entries()];
  const results = await mapWithConcurrency(entries, concurrencyFor(resolveProvider()), async ([slug, sectionText]) => {
    const team = TEAMS.find((t) => t.slug === slug)!;
    const synthesis = await synthesizeTeamSection(team, sectionText, session);
    return synthesis ? { ...synthesis, session } : null;
  });

  return results.filter((r): r is WttsTeamSynthesis => r !== null);
}
