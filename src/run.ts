// CLI entrypoint — `npm run sync`. On-demand only, never scheduled/automatic.
//
// 1. Fetch F1.com's latest-news feed, filter to "What the teams said" items,
//    merge new ones into the local article store (data/articles.json).
// 2. Refresh FIA transcripts/documents for the current Grand Prix
//    (data/fia/<event>.json).
// 3. Run the AI extraction for any stored article that doesn't have one yet.
//
// The web viewer (`npm run dev`) only ever reads this local data — it never
// hits the network itself except through the same "Rafraîchir" actions.

import "dotenv/config";
import { fetchWttsFeedItems } from "./rss";
import { getArticleFullText } from "./article-fetcher";
import { synthesizeArticle, resolveProvider } from "./synthesis";
import { getAllArticles, addArticles, setSynthesis } from "./article-store";
import { ingestStories, determineCurrentEventName } from "./stories-data";

async function syncSynthesis(): Promise<{ synthesized: number; alreadyDone: number }> {
  const articles = getAllArticles().filter((a) => /^what the teams said/i.test(a.title));
  const toGenerate = articles.filter((a) => !a.teamsSynthesis);

  let synthesized = 0;
  for (const article of toGenerate) {
    console.log(`\n--- ${article.title} ---`);
    const text = await getArticleFullText(article.url);
    if (!text) {
      console.warn("  texte introuvable, réessayé au prochain sync.");
      continue;
    }
    const teams = await synthesizeArticle(text, article.title);
    if (teams.length === 0) {
      console.warn("  aucune écurie extraite.");
      continue;
    }
    setSynthesis(article.url, teams);
    console.log(`  -> ${teams.length} écurie(s)`);
    synthesized++;
  }

  return { synthesized, alreadyDone: articles.length - toGenerate.length };
}

async function main() {
  const provider = resolveProvider();
  if (provider === "none") {
    console.error(
      "Aucun fournisseur IA configuré. Copie .env.example vers .env et renseigne LLM_PROVIDER (ollama ou anthropic).",
    );
    process.exit(1);
  }
  console.log(`Fournisseur IA : ${provider}`);

  console.log("\nRécupération du flux F1.com...");
  const items = await fetchWttsFeedItems();
  const added = addArticles(items);
  console.log(`${items.length} article(s) "What the teams said" dans le flux, ${added.length} nouveau(x).`);

  const event = await determineCurrentEventName();
  if (event) {
    console.log(`\nGrand Prix courant : ${event}`);
    console.log("Rafraîchissement FIA (transcriptions + documents)...");
    const report = await ingestStories(event);
    console.log(`  -> ${report.addedTranscripts} transcription(s), ${report.addedDocuments} document(s) ajouté(s)`);
  }

  console.log("\nSynthèse IA des articles non traités...");
  const { synthesized, alreadyDone } = await syncSynthesis();
  console.log(`${synthesized} article(s) synthétisé(s), ${alreadyDone} déjà en cache.`);

  console.log("\nTerminé.");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
