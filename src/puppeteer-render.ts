// Headless-Chrome rendering via bundled Puppeteer Chromium, for environments
// that don't have a local Chrome install (CI runners) — unlike
// gen_stories_from_transcript.ts's execFileSync + hardcoded chrome.exe path,
// this works the same locally and in GitHub Actions.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  // --no-sandbox: CI runners execute as root, where Chromium's sandbox
  // refuses to start at all; harmless locally too.
  if (!browserPromise) browserPromise = puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  await browser.close();
  browserPromise = null;
}

/** Renders `templateSrc` (with its `const DATA = {...}` block already
 * substituted) to a 1080x1920 PNG at `outPath`. Writes the temp .html file
 * directly inside `templateDir` (not a subdirectory!) so the template's
 * relative asset paths (../assets/...) resolve exactly one level up, same as
 * the local Chrome pipeline in gen_stories_from_transcript.ts. */
export async function renderCardPuppeteer(templateSrc: string, templateDir: string, outPath: string): Promise<void> {
  const tmpPath = join(templateDir, `_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(tmpPath, templateSrc, "utf-8");
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });
    await page.goto(`file:///${tmpPath.replace(/\\/g, "/")}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outPath as `${string}.png`, type: "png" });
    await page.close();
  } finally {
    rmSync(tmpPath, { force: true });
  }
}
