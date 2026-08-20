// Shared "which Q&A pairs are worth showing" logic between scripts/cloud-digest.ts
// (the unattended Telegram digest) and scripts/gen_stories_from_transcript.ts
// (local card generation via --pick). Keeping this in one place guarantees the
// numbering the user sees on Telegram lines up exactly with the indices
// gen_stories_from_transcript.ts --pick expects — same filter, same order.

import { resolvePerson, type ResolvedPerson } from "./asset-manifest";
import type { TranscriptQA } from "./transcript";

// Deliberately not an LLM "is this substantive" judgment — see cloud-digest.ts's
// header comment. A length floor is a blunt proxy for "worth a card": raised
// to 300 (from an initial 50, then 150) after the first real runs sent
// 62 then 55 cards for one transcript — still no editorial judgment, but
// this cuts closer to what a curated batch would look like (~39 on the
// transcript this was tuned against) at the cost of dropping some short-but-
// punchy answers.
export const MIN_ANSWER_LEN = 300;

export type EligibleEntry = { qa: TranscriptQA; person: ResolvedPerson };

/** The exact same list, in the exact same order, a Telegram digest numbered
 * 1..N — a speaker known to the manifest, answering with more than a
 * one-liner. `--pick 3,7` on gen_stories_from_transcript.ts indexes into
 * this list (1-based) so it matches what the user read on Telegram. */
export function eligibleEntries(qas: TranscriptQA[]): EligibleEntry[] {
  return qas
    .filter((qa) => qa.answer.length >= MIN_ANSWER_LEN)
    .map((qa) => {
      const person = resolvePerson(qa.speaker);
      return person ? { qa, person } : null;
    })
    .filter((x): x is EligibleEntry => x !== null);
}
