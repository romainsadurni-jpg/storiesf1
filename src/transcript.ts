// FIA press-conference transcript parser — turns the raw HTML body from
// fia.com into a flat list of {question, answer} pairs, one per speaker turn.
// Purely deterministic (regex-based), no LLM involved: the transcripts follow
// a rigid, predictable markup (verified against several 2026 GP transcripts),
// so structure extraction doesn't need a model — only the later step that
// turns an answer into a short French story quote does.

import { TEAMS } from "./teams";

export type TranscriptQA = {
  /** "PART ONE", "QUESTIONS FROM THE FLOOR", etc. — whatever section header
   * last preceded this pair, or null if the transcript has none. */
  section: string | null;
  /** The question text, with any leading "(Journalist – Outlet)" byline
   * stripped out (kept separately in `journalist`). */
  question: string;
  /** "(Name – Outlet)" byline for floor questions, else null (the
   * moderator/anchor questions in PART ONE/TWO never carry one). */
  journalist: string | null;
  /** Full name of the person answering, resolved from initials via the
   * roster built off the transcript's own "PART ONE – X (Team), Y (Team)"
   * headers — falls back to whatever label the transcript used verbatim if
   * it can't be resolved (unknown initials, guest not in any header). */
  speaker: string;
  team: string | null;
  answer: string;
};

type RosterEntry = { fullName: string; team: string | null };

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function initialsOf(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function resolveTeamSlug(rawTeam: string): string | null {
  const key = rawTeam.trim().toLowerCase();
  const aliases: Record<string, string> = {
    "red bull racing": "redbull",
    "red bull": "redbull",
    "racing bulls": "racingbulls",
    "aston martin": "astonmartin",
  };
  if (aliases[key]) return aliases[key];
  const found = TEAMS.find((t) => t.name.toLowerCase() === key);
  return found ? found.slug : null;
}

/** Parses a "PART ONE – Name SURNAME (Team), Name SURNAME (Team)" or
 * "DRIVERS\n1 – Name SURNAME (Team)" style roster line into entries, keyed
 * by the initials the transcript will later abbreviate them to. */
function extractRosterEntries(text: string): Map<string, RosterEntry> {
  const roster = new Map<string, RosterEntry>();
  const personRe = /([A-Z][a-zA-Z.'’-]*(?:\s+[A-Z][a-zA-Z.'’-]*)*\s+[A-ZÀ-Þ][A-ZÀ-Þ’'-]{2,})\s*\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = personRe.exec(text))) {
    const fullNameRaw = m[1].trim();
    const team = resolveTeamSlug(m[2]);
    // Title-case the surname (it's transcribed in caps: "LINDBLAD" -> "Lindblad").
    const parts = fullNameRaw.split(/\s+/);
    const fullName = parts
      .map((p, i) => (i === parts.length - 1 ? p[0] + p.slice(1).toLowerCase() : p))
      .join(" ");
    roster.set(initialsOf(fullNameRaw), { fullName, team });
    roster.set(fullNameRaw.toUpperCase(), { fullName, team });
  }
  return roster;
}

const SECTION_HEADER_RE = /^(PART (ONE|TWO|THREE)|QUESTIONS FROM THE FLOOR|TRACK INTERVIEWS|PRESS CONFERENCE|PARC FERM[EÉ] INTERVIEWS|TEAM REPRESENTATIVES|DRIVERS|ENDS)\b/i;

type Segment = { label: string; text: string };

/** Splits one paragraph's inner HTML into (label, trailing-text) segments —
 * every transcript paragraph is a flat sequence of <strong>label</strong>
 * blocks, each followed by that label's own plain-text content (empty for
 * question/section labels, the spoken answer for a name label). */
function segmentParagraph(innerHtml: string): Segment[] {
  const withBreaks = innerHtml.replace(/<br\s*\/?>/gi, "\n");
  const re = /<strong>([\s\S]*?)<\/strong>([\s\S]*?)(?=<strong>|$)/g;
  const segments: Segment[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(withBreaks))) {
    const label = normalizeWhitespace(decodeEntities(stripTags(m[1])));
    const text = normalizeWhitespace(decodeEntities(stripTags(m[2])));
    if (label) segments.push({ label, text });
  }
  return segments;
}

/** Extracts every <p>...</p> block's inner HTML from a content-body div. */
function extractParagraphs(bodyHtml: string): string[] {
  const re = /<p[^>]*>([\s\S]*?)<\/p>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml))) out.push(m[1]);
  return out;
}

const JOURNALIST_PREFIX_RE = /^\(([^)]+)\)\s*/;

/** Parses a transcript's `.content-body` inner HTML into flat Q/A pairs.
 * `bodyHtml` should be everything inside `<div class="content-body">...`. */
export function parseTranscriptBody(bodyHtml: string): TranscriptQA[] {
  const paragraphs = extractParagraphs(bodyHtml);

  let roster = new Map<string, RosterEntry>();
  let section: string | null = null;
  let currentQuestion: { text: string; journalist: string | null } | null = null;
  const results: TranscriptQA[] = [];

  for (const para of paragraphs) {
    for (const { label, text } of segmentParagraph(para)) {
      const sectionMatch = label.match(SECTION_HEADER_RE);
      if (sectionMatch) {
        section = sectionMatch[1].toUpperCase();
        // Section headers that also carry a roster ("PART ONE – X (Team), Y (Team)")
        // refresh the initials map for everything that follows.
        if (/\(.+\)/.test(label)) {
          const fresh = extractRosterEntries(label);
          if (fresh.size > 0) roster = fresh;
        }
        currentQuestion = null;
        continue;
      }

      if (/^Q\s*:/i.test(label)) {
        let q = label.replace(/^Q\s*:\s*/i, "");
        const jm = q.match(JOURNALIST_PREFIX_RE);
        const journalist = jm ? jm[1].trim() : null;
        if (jm) q = q.slice(jm[0].length);
        currentQuestion = { text: q.trim(), journalist };
        continue;
      }

      // A remaining ":"-suffixed label with no question active isn't a
      // speaker turn we can attach anywhere (e.g. a stray roster line) —
      // skip it rather than emit an orphaned answer.
      if (!currentQuestion || !text) continue;

      const rawLabel = label.replace(/:\s*$/, "").trim();
      const resolved = roster.get(rawLabel.toUpperCase()) ?? roster.get(initialsOf(rawLabel));
      results.push({
        section,
        question: currentQuestion.text,
        journalist: currentQuestion.journalist,
        speaker: resolved?.fullName ?? rawLabel,
        team: resolved?.team ?? null,
        answer: text,
      });
    }
  }

  return results;
}

/** Extracts the raw inner HTML of `<div class="content-body">...</div>`
 * from a full FIA transcript page. */
export function extractContentBodyHtml(pageHtml: string): string | null {
  const start = pageHtml.indexOf('class="content-body"');
  if (start === -1) return null;
  const divStart = pageHtml.lastIndexOf("<div", start);
  if (divStart === -1) return null;
  // Walk forward tracking div nesting depth to find this div's matching close.
  const tagRe = /<div\b[^>]*>|<\/div>/gi;
  tagRe.lastIndex = divStart;
  let depth = 0;
  let m: RegExpExecArray | null;
  let contentStart = -1;
  while ((m = tagRe.exec(pageHtml))) {
    if (m[0].toLowerCase() === "</div>") {
      depth--;
      if (depth === 0) return pageHtml.slice(contentStart, m.index);
    } else {
      depth++;
      if (depth === 1) contentStart = m.index + m[0].length;
    }
  }
  return null;
}
