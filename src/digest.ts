// Shared "which Q&A pairs are worth considering" logic between
// scripts/cloud-digest.ts (fully automated, runs in CI) and
// scripts/gen_stories_from_transcript.ts (local, on demand). Only filters on
// whether the speaker is a known driver/principal (portrait available) —
// deliberately NOT a length or keyword heuristic. Earlier attempts at a
// length floor (50, then 150, then 300 chars) were tried and dropped: they
// can't tell a real answer from a short-but-punchy one, and are redundant
// once an LLM's own "real question, real answer" judgment (see
// transcript-synthesis.ts's EXTRACT_SYSTEM_PROMPT) does that curation
// properly downstream.

import { resolvePerson, type ResolvedPerson } from "./asset-manifest";
import type { TranscriptQA } from "./transcript";

export type EligibleEntry = { qa: TranscriptQA; person: ResolvedPerson };

export function eligibleEntries(qas: TranscriptQA[]): EligibleEntry[] {
  return qas
    .map((qa) => {
      const person = resolvePerson(qa.speaker);
      return person ? { qa, person } : null;
    })
    .filter((x): x is EligibleEntry => x !== null);
}
