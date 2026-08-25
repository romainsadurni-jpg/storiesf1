// One "story card" per press article — shared by the web UI's "Générer les
// stories" button (server.ts) and the automated Telegram digest
// (scripts/articles-digest.ts). Extracted so both callers run the exact
// same subject-resolution/fallback logic instead of drifting apart.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getArticleFullText } from "./article-fetcher";
import { synthesizeArticleCard, translateContextQuote, type ArticleCardText } from "./article-synthesis";
import { resolvePerson, randomPortraitFor, randomBackgroundFor, findKnownSubject, teamLogoPath, orgLogoPath } from "./asset-manifest";
import { renderCardPuppeteer } from "./puppeteer-render";
import { setStoryResult, type StoredNewsArticle } from "./news-store";
import { TEAMS } from "./teams";
import { ORGS } from "./orgs";

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
  /** True when `portrait` is a team badge (teamLogoPath) rather than a
   * face photo — the template renders these "contain"-fit on a white
   * backing instead of the face-oriented "cover" crop. */
  isLogo: boolean;
  /** Overrides the logo's white backing (see isLogo) for a logo file with
   * its own opaque background baked in — orgs.ts's per-org setting. */
  logoBackground?: string;
  background: string;
};

/** Every article gets a card — no roster filter. Tries, in order: a known
 * driver/principal (asset-manifest.ts, real portrait), then a known
 * constructor (teams.ts — its badge if one exists on disk, initials
 * otherwise), then a fully generic card (still readable, just no team
 * branding) for anyone/anything else (pundits, FIA, other orgs).
 *
 * `contextText` (the card's own context+quote, plus the article title) is
 * searched for the team match, not just `subjectName` — a pundit quoted
 * commenting on Verstappen's Red Bull deal is correctly left with no
 * portrait (Karun Chandhok isn't a driver/principal), but the article is
 * still fundamentally about Red Bull, so the background/badge should say so
 * instead of falling all the way to a team-less generic card. Institutional
 * subjects (orgs.ts — FIA and the like) get the same badge treatment as a
 * constructor, just from their own assets/orgs/ tree since they aren't an
 * "écurie" with their own TEAM_COLORS entry in quote-card.html. */
export function resolveSubject(subjectName: string, contextText: string): CardSubject {
  const person = resolvePerson(subjectName);
  if (person) {
    return {
      name: person.name,
      role: person.role,
      isDriver: person.isDriver,
      team: person.team,
      portrait: randomPortraitFor(person),
      isLogo: false,
      background: randomBackgroundFor(person.team),
    };
  }

  const haystack = `${subjectName} ${contextText}`.toLowerCase();
  const team = TEAMS.find((t) => haystack.includes(t.name.toLowerCase()));
  if (team) {
    const logo = teamLogoPath(team.slug);
    return {
      name: subjectName,
      role: null,
      isDriver: false,
      team: team.slug,
      portrait: logo ?? NO_PORTRAIT_PATH,
      isLogo: logo !== null,
      background: randomBackgroundFor(team.slug),
    };
  }

  const org = ORGS.find((o) => haystack.includes(o.name.toLowerCase()));
  if (org) {
    const logo = orgLogoPath(org.slug);
    return {
      name: subjectName,
      role: null,
      isDriver: false,
      team: org.slug,
      portrait: logo ?? NO_PORTRAIT_PATH,
      isLogo: logo !== null,
      logoBackground: org.logoBackground,
      background: randomBackgroundFor(org.slug),
    };
  }

  return {
    name: subjectName,
    role: null,
    isDriver: false,
    team: "generic",
    portrait: NO_PORTRAIT_PATH,
    isLogo: false,
    background: randomBackgroundFor("generic"),
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
// extraction+translation that already failed above).
//
// Returns null when even that last pass fails: this used to fall through
// to a source-name-as-context / English-title-as-quote card, which is
// exactly the "near-empty card" symptom reported after the first day of
// live Telegram delivery (see a604589) — a card that LOOKS finished but
// is either half-English or content-free is worse than no card at all,
// since the digest sends every rendered card straight to Telegram with no
// human in the loop. generateArticleStory() below treats null the same as
// a genuine synthesis failure: no card, article recorded as skipped and
// left for manual retry, nothing shipped.
async function deterministicCardText(article: StoredNewsArticle): Promise<ArticleCardText | null> {
  const titleLower = article.title.toLowerCase();
  const subjectName =
    findKnownSubject(article.title) ??
    TEAMS.find((t) => titleLower.includes(t.name.toLowerCase()))?.name ??
    ORGS.find((o) => titleLower.includes(o.name.toLowerCase()))?.name ??
    article.source;

  const rawContext = article.summary?.trim().slice(0, 220) || article.source;
  const translated = await translateContextQuote(rawContext, article.title);
  if (translated) return { subjectName, context: translated.context, quote: translated.quote, verbatim: false };

  return null;
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
// does for FIA transcript Q/A pairs. resolveSubject() always returns
// something renderable, and most content-level LLM failures recover via
// deterministicCardText() above, so a card is generated for the vast
// majority of articles. The exceptions that surface as a skip: "no LLM
// provider configured at all" (an environment problem affecting every
// article identically) and every translation path failing outright for one
// article (deterministicCardText returning null) — both cases return null
// here rather than shipping a half-finished card, so callers can record the
// skip and move on instead of auto-publishing something degraded.
export async function generateArticleStory(article: StoredNewsArticle): Promise<ArticleStoryResult | null> {
  const fullText = await getArticleFullText(article.url);
  const textForSynthesis = fullText ?? article.summary ?? article.title;

  let cardText: ArticleCardText;
  try {
    const synthesized = (await synthesizeArticleCard(article.title, textForSynthesis)) ?? (await deterministicCardText(article));
    if (!synthesized) throw new Error("traduction impossible (extraction LLM et secours de traduction ont tous les deux échoué)");
    cardText = synthesized;
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
    isLogo: subject.isLogo,
    logoBackground: subject.logoBackground,
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
