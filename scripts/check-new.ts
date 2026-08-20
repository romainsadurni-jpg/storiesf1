// Cheap pre-check for the GitHub Actions workflow: is there a new FIA
// transcript at all? No Ollama, no Puppeteer, no Telegram — just the
// current-event lookup + transcript existence check, so idle runs (the vast
// majority — most 5-minute ticks find nothing new) stay fast and don't burn
// Actions minutes starting a whole LLM/rendering pipeline for nothing.
//
// Prints "true" or "false" to stdout; the workflow step captures it into a
// GITHUB_OUTPUT to gate the heavy steps (Ollama install, cloud-digest.ts).

import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { determineCurrentEventName } from "../src/stories-data";
import { fetchTranscriptsForEvent } from "../src/fia";

const SEEN_PATH = join(__dirname, "..", "data", "telegram-seen.json");

function loadSeen(): Set<string> {
  if (!existsSync(SEEN_PATH)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(SEEN_PATH, "utf-8")) as string[]);
  } catch {
    return new Set();
  }
}

async function main() {
  const event = await determineCurrentEventName();
  if (!event) {
    console.log("false");
    return;
  }
  const seen = loadSeen();
  const transcripts = await fetchTranscriptsForEvent(event);
  const hasNew = transcripts.some((t) => !seen.has(t.url));
  console.log(hasNew ? "true" : "false");
}

main().catch((e) => {
  console.error(e);
  console.log("false"); // fail closed — skip the heavy pipeline rather than risk a broken run every 5 minutes
});
