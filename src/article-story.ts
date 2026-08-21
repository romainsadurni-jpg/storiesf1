// One "story card" per press article — shared by the web UI's "Générer les
// stories" button (server.ts) and the automated Telegram digest
// (scripts/articles-digest.ts). Extracted so both callers run the exact
// same subject-resolution/fallback logic instead of drifting apart.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getArticleFullText } from "./article-fetcher";
import { synthesizeArticleCard, translateContextQuote, type ArticleCardText } from "./article-synthesis";
import { resolvePerson, randomPortraitFor, randomBackgroundFor, findKnownSubject } from "./asset-manifest";
import { renderCardPuppeteer } from "./puppeteer-render";
import { setStoryResult, type StoredNewsArticle } from "./news-store";
import { TEAMS } from "./teams";

const BASE_DIR = join(__dirname, "..");
const TEMPLATES_DIR = join(BASE_DIR, "templates");
const OUTPUT_DIR = join(BASE_DIR, "output");
const ARTICLES_OUT_DIR = join(OUTPUT_DIR, "articles");
const QUOTE_TEMPLATE_PATH = join(TEMPLATES_DIR, "quote-card.html");
const HANDLE = "@SaD_F1";

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents (é -> e) before stripping non-alnum, else "Pérez" -> "p-rez"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Deliberately-broken path so quote-card.html's own onerror handler falls
// back to the initials circle — same "graceful fallback" contract STYLE.md
// documents for a missing asset, just triggered on purpose here since
// there's no real photo to point to for a subject outside the roster.
const NO_PORTRAIT_PATH = "../assets/__no_portrait__.jpg";

export type CardSubject = {
  name: string;
  role: string | null;
  isDriver: boolean;
  team: string;
  portrait: string;
  background: string;
};

/** Every article gets a card — no roster filter. Tries, in order: a known
 * driver/principal (asset-manifest.ts, real portrait), then a known
 * constructor (teams.ts, team colors + background but initials instead of a
 * photo), then a fully generic card (still readable, just no team branding)
 * for anyone/anything else (pundits, FIA, other orgs).
 *
 * `contextText` (the card's own context+quote, plus the article title) is
 * searched for the team match, not just `subjectName` — a pundit quoted
 * commenting on Verstappen's Red Bull deal is correctly left with no
 * portrait (Karun Chandhok isn't a driver/principal), but the article is
 * still fundamentally about Red Bull, so the background should say so
 * instead of falling all the way to a team-less generic card. */
export function resolveSubject(subjectName: string, contextText: string): CardSubject {
  const person = resolvePerson(subjectName);
  if (person) {
    return {
      name: person.name,
      role: person.role,
      isDriver: person.isDriver,
      team: person.team,
      portrait: randomPortraitFor(person),
      background: randomBackgroundFor(person.team),
    };
  }

  const haystack = `${subjectName} ${contextText}`.toLowerCase();
  const team = TEAMS.find((t) => haystack.includes(t.name.toLowerCase()));
  const teamSlug = team?.slug ?? "generic";
  return {
    name: subjectName,
    role: null,
    isDriver: false,
    team: teamSlug,
    portrait: NO_PORTRAIT_PATH,
    background: randomBackgroundFor(teamSlug),
  };
}

// Deterministic-subject fallback for when article-synthesis.ts's full
// extraction couldn't produce anything usable (e.g. a caption-only
// "Spotlight" brief with too little text for the model to extract a quote
// from, or every extraction attempt still came back English) — the
// subject comes from a deterministic scan instead of the model's read of
// the full text, and the article's title/summary still get one last,
// much simpler translate-only pass (see translateContextQuote — a plain
// two-sentence translation succeeds far more often than the combined
// extraction+translation that already failed above) so the card isn't
// left with just the source name as "context" and an English title as
// "quote". Only degrades to the fully English/source-only version if that
// last pass also fails or no LLM is available. Keeps the "one card per
// article, no exceptions" guarantee even on content the LLM step
// genuinely can't work with.
async function deterministicCardText(article: StoredNewsArticle): Promise<ArticleCardText> {
  const titleLower = article.title.toLowerCase();
  const subjectName =
    findKnownSubject(article.title) ?? TEAMS.find((t) => titleLower.includes(t.name.toLowerCase()))?.name ?? article.source;

  const rawContext = article.summary?.trim().slice(0, 220) || article.source;
  const translated = await translateContextQuote(rawContext, article.title);
  if (translated) return { subjectName, context: translated.context, quote: translated.quote, verbatim: false };

  return { subjectName, context: article.source, quote: article.title, verbatim: false };
}

export type ArticleStoryResult = {
  outPath: string;
  fileName: string;
  subject: CardSubject;
  cardText: ArticleCardText;
};

// One "story card" per article — title's subject as question, the model's
// context+quote as the answer found in the text (article-synthesis.ts),
// rendered onto quote-card.html the same way gen_stories_from_transcript.ts
// does for FIA transcript Q/A pairs. No filter of any kind: resolveSubject()
// always returns something renderable, and any content-level LLM failure
// falls back to deterministicCardText() above, so a card is generated for
// every single article. The one thing that still surfaces as a skip is "no
// LLM provider configured at all" — an environment problem affecting every
// article identically, not a per-article judgment call, so it's worth
// surfacing rather than silently downgrading every card to the fallback
// (returns null in that case; other failures propagate so callers can
// decide how to record them).
export async function generateArticleStory(article: StoredNewsArticle): Promise<ArticleStoryResult | null> {
  const fullText = await getArticleFullText(article.url);
  const textForSynthesis = fullText ?? article.summary ?? article.title;

  let cardText: ArticleCardText;
  try {
    cardText = (await synthesizeArticleCard(article.title, textForSynthesis)) ?? (await deterministicCardText(article));
  } catch (e) {
    setStoryResult(article.url, { reason: e instanceof Error ? e.message : String(e) });
    return null;
  }

  const subject = resolveSubject(cardText.subjectName, `${cardText.context} ${cardText.quote} ${article.title}`);

  const data = {
    context: cardText.context,
    quote: cardText.quote,
    name: subject.name,
    role: subject.role,
    isDriver: subject.isDriver,
    team: subject.team,
    handle: HANDLE,
    portrait: subject.portrait,
    background: subject.background,
  };

  const templateSrc = readFileSync(QUOTE_TEMPLATE_PATH, "utf-8");
  const dataBlock = "const DATA = " + JSON.stringify(data) + ";";
  const filledSrc = templateSrc.replace(/const DATA = \{[\s\S]*?\};/, dataBlock);

  mkdirSync(ARTICLES_OUT_DIR, { recursive: true });
  const fileName = `${slugify(article.source)}-${slugify(subject.name)}-${Date.now()}.png`;
  const outPath = join(ARTICLES_OUT_DIR, fileName);
  await renderCardPuppeteer(filledSrc, TEMPLATES_DIR, outPath);

  setStoryResult(article.url, { storyPath: `articles/${fileName}` });
  return { outPath, fileName, subject, cardText };
}
