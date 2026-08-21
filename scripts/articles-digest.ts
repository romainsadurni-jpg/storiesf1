// Entry point for the GitHub Actions workflow (.github/workflows/articles-watch.yml).
// Fully unattended, every 5 minutes: pulls every NEWS_SOURCES feed, and for
// every article not yet processed (news-store.ts's storyPath/storySkipReason,
// same "processed" bookkeeping the web UI's "Générer les stories" button
// uses) fetches the full text, condenses title+content into a French
// context+quote via the LLM (article-synthesis.ts), renders a quote-card PNG
// (article-story.ts — same module the web UI uses), and sends it straight to
// Telegram. No score filter: every new article becomes a story.
//
// Usage: npx tsx scripts/articles-digest.ts
// Requires env vars TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, plus whatever
// LLM_PROVIDER/OLLAMA_*/ANTHROPIC_* synthesis.ts's resolveProvider() needs.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { ingestNewsArticles } from "../src/news-ingest";
import { listNewsArticles, setStoryResult, type StoredNewsArticle } from "../src/news-store";
import { generateArticleStory } from "../src/article-story";
import { closeBrowser } from "../src/puppeteer-render";

async function sendTelegramPhoto(token: string, chatId: string, path: string, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption.slice(0, 1024));
  form.append("photo", new Blob([readFileSync(path)], { type: "image/png" }), path.split(/[\\/]/).pop());
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendPhoto failed: ${data.description ?? res.status}`);
}

function pending(articles: StoredNewsArticle[]): StoredNewsArticle[] {
  return articles.filter((a) => !a.storyPath && !a.storySkipReason);
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars are required");

  console.log("Fetching press feeds...");
  const { totalAdded, errors } = await ingestNewsArticles();
  console.log(`${totalAdded} new article(s) across all sources.`);
  if (errors.length > 0) console.warn("Feed errors:", errors);

  const todo = pending(listNewsArticles());
  console.log(`${todo.length} article(s) pending a story.`);

  try {
    for (const article of todo) {
      console.log(`Processing: ${article.title}`);

      // Generation failure (fetch/render/LLM) is recorded via setStoryResult
      // (inside generateArticleStory, or here on an uncaught throw) so the
      // article isn't retried forever — same permanence the web UI's
      // "Générer les stories" button already accepts. A Telegram-send
      // failure below is handled separately: the card is already rendered
      // and marked, so don't reclassify it as a generation failure — just
      // log it and move on (the next run's fresh articles matter more than
      // relentlessly re-sending one that hit a transient network error).
      let result: Awaited<ReturnType<typeof generateArticleStory>>;
      try {
        result = await generateArticleStory(article);
      } catch (e) {
        console.error(`  generation failed, will retry next run: ${e instanceof Error ? e.message : e}`);
        setStoryResult(article.url, { reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (!result) {
        console.log("  skipped (no LLM provider / synthesis failure, recorded).");
        continue;
      }

      const { subject, cardText, outPath } = result;
      const caption = `${subject.name}\n${cardText.quote}\n\n${article.title}\n${article.url}`;
      try {
        await sendTelegramPhoto(token, chatId, outPath, caption);
        console.log(`  -> sent to Telegram (${result.fileName})`);
      } catch (e) {
        console.error(`  card generated but Telegram send failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await closeBrowser();
  }

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
