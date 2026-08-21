// Editorial relevance score for press articles (0–100) — verbatim port of
// f1-editorial-os's lib/score-news.ts. Pure function, no I/O, so the
// scoring logic itself carries over unchanged; only the input dates switch
// from Prisma's `Date` fields to this project's ISO-string JSON fields.
//
// Four independent axes, each capped, summed to 100 max:
//   Fraîcheur   30 pts  — age of the article
//   Source      15 pts  — authority of the outlet category
//   Impact      35 pts  — keyword severity (crash > transfer > podium …)
//   Entité      20 pts  — top driver / top constructor mentioned

// ---------------------------------------------------------------------------
// Entity lists
// ---------------------------------------------------------------------------

const TOP_DRIVERS = [
  "verstappen", "hamilton", "leclerc", "norris", "sainz", "russell",
  "piastri", "alonso", "perez", "pérez", "vettel", "raikkonen", "räikkönen",
  "gasly", "ocon", "stroll", "albon", "tsunoda", "bottas", "zhou",
  "lawson", "bearman", "colapinto", "doohan", "hulkenberg", "hülkenberg",
  "magnussen",
];

const TOP_TEAMS = ["red bull", "ferrari", "mercedes", "mclaren"];
const MID_TEAMS = [
  "alpine", "aston martin", "williams", "haas", "sauber",
  "kick sauber", "visa rb", "racing bulls",
];

// ---------------------------------------------------------------------------
// Keyword tiers  (first matching group wins for that tier)
// ---------------------------------------------------------------------------

// Tier A — dramatic, safety or massive-news events → up to 35 pts
const KEYWORDS_A: RegExp[] = [
  /\b(mort|décès|décède|tué|fatal|tribute|hommage|killed|hospitalisé|blessé\s+grave)\b/,
  /\b(disqualif|exclu|exclusion|banned|suspend[eu])\b/,
  /\b(champion(?:nat|ship)?|titre\s+mondial|world\s+(?:champion|title)|sacre)\b/,
];

// Tier B — significant news → up to 22 pts
const KEYWORDS_B: RegExp[] = [
  /\b(sign(?:e|é|ed)|contrat|transfert|rejoint|recrutement|prolonge|nouveau\s+pilote)\b/,
  /\b(crash|accident|collision|sortie\s+de\s+piste|retraite|retire[sd]?|quitte)\b/,
  /\b(record|pole(?:\s+position)?|fastest\s+lap|tour\s+le\s+plus\s+rapide)\b/,
  /\b(victoire|vainqueur|remporte|wins?|victory)\b/,
  /\b(pénalité|penalty|sanction|protestation|appeal|appel)\b/,
];

// Tier C — notable but routine → up to 10 pts
const KEYWORDS_C: RegExp[] = [
  /\b(officiel|annonce|présentation|reveal|dévoil)\b/,
  /\b(essais|tests?|practice|qualifying|qualif)\b/,
  /\b(mise\s+à\s+jour|upgrade|évolution|développement|update)\b/,
  /\b(rumeur|rumor|selon|selon\s+nos\s+sources|sources\s+indiquent)\b/,
];

// ---------------------------------------------------------------------------
// Score components
// ---------------------------------------------------------------------------

function freshness(publishedAt: Date | null, fetchedAt: Date): number {
  const ref = publishedAt ?? fetchedAt;
  const ageH = (Date.now() - ref.getTime()) / 3_600_000;
  if (ageH < 1) return 30;
  if (ageH < 3) return 25;
  if (ageH < 6) return 20;
  if (ageH < 12) return 15;
  if (ageH < 24) return 10;
  if (ageH < 48) return 5;
  return 2;
}

function sourceWeight(category: string): number {
  if (category === "official") return 15; // FIA, F1.com
  if (category === "stats") return 12; // stats / data sites
  if (category === "news") return 10; // established press
  if (category === "rumeur") return 8; // rumeurs / gossip
  return 6; // community / blogs
}

function impactScore(text: string): number {
  // Tier A → 35, tier B → 22, tier C → 10, no match → 0
  if (KEYWORDS_A.some((re) => re.test(text))) return 35;
  if (KEYWORDS_B.some((re) => re.test(text))) return 22;
  if (KEYWORDS_C.some((re) => re.test(text))) return 10;
  return 0;
}

function entityScore(text: string): number {
  let s = 0;
  if (TOP_DRIVERS.some((d) => text.includes(d))) s += 12;
  if (TOP_TEAMS.some((t) => text.includes(t))) s += 8;
  else if (MID_TEAMS.some((t) => text.includes(t))) s += 4;
  return Math.min(s, 20);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type NewsScore = {
  score: number;
  breakdown: { fraicheur: number; source: number; impact: number; entite: number };
};

export function scoreNews(a: {
  title: string;
  summary: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  sourceCategory: string;
}): NewsScore {
  const text = `${a.title} ${a.summary ?? ""}`.toLowerCase();

  const breakdown = {
    fraicheur: freshness(a.publishedAt ? new Date(a.publishedAt) : null, new Date(a.fetchedAt)),
    source: sourceWeight(a.sourceCategory),
    impact: impactScore(text),
    entite: entityScore(text),
  };

  const score = Math.min(100, breakdown.fraicheur + breakdown.source + breakdown.impact + breakdown.entite);

  return { score, breakdown };
}
