// Cheap pre-check for the GitHub Actions workflow: is there at least one
// article pending a story (freshly fetched, or already stored but not yet
// processed)? No Ollama, no Puppeteer, no Telegram — just the RSS ingest +
// a state check, so idle runs (most 5-minute ticks find nothing new) stay
// fast and don't burn Actions minutes starting a whole LLM/rendering
// pipeline for nothing. Mirrors check-new.ts's role for the FIA workflow.
//
// Prints "true" or "false" to stdout; the workflow step captures it into a
// GITHUB_OUTPUT to gate the heavy steps (Ollama install, articles-digest.ts).

import "dotenv/config";
import { ingestNewsArticles } from "../src/news-ingest";
import { listNewsArticles } from "../src/news-store";

async function main() {
  await ingestNewsArticles();
  const pending = listNewsArticles().some((a) => !a.storyPath && !a.storySkipReason);
  console.log(pending ? "true" : "false");
}

main().catch((e) => {
  console.error(e);
  console.log("false"); // fail closed — skip the heavy pipeline rather than risk a broken run every 5 minutes
});
