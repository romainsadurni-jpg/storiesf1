// Shared "which Q&A pairs are worth considering" logic between
// scripts/cloud-digest.ts (fully automated, runs in CI) and
// scripts/gen_stories_from_transcript.ts (local, on demand).
//
// Two gates, deliberately kept separate: this length floor is a cheap
// pre-filter that keeps the volume roughly predictable (~39 cards on the
// transcript this was tuned against, down from 66 raw candidates) BEFORE
// spending any LLM time; the real quality judgment ("is this actually a
// substantive answer") still happens downstream in transcript-synthesis.ts's
// EXTRACT_SYSTEM_PROMPT (stats.notReal) — this floor doesn't replace that,
// it just avoids burning LLM calls on the obvious one-liners.

import { resolvePerson, type ResolvedPerson } from "./asset-manifest";
import type { TranscriptQA } from "./transcript";

export const MIN_ANSWER_LEN = 300;

export type EligibleEntry = { qa: TranscriptQA; person: ResolvedPerson };

export function eligibleEntries(qas: TranscriptQA[]): EligibleEntry[] {
  return qas
    .filter((qa) => qa.answer.length >= MIN_ANSWER_LEN)
    .map((qa) => {
      const person = resolvePerson(qa.speaker);
      return person ? { qa, person } : null;
    })
    .filter((x): x is EligibleEntry => x !== null);
}
