// Free, keyless machine translation via MyMemory (api.mymemory.translated.net)
// — no LLM, no editorial rewrite, just literal EN->FR translation. Chosen
// deliberately over an LLM condensation step for the unattended pipeline (see
// scripts/cloud-generate.ts): zero API cost, zero external agent usage.
// Anonymous tier caps requests around 500 characters — callers must
// pre-truncate before calling this (see truncateWords below).

const MYMEMORY_BASE = "https://api.mymemory.translated.net/get";

export async function translateToFrench(text: string): Promise<string> {
  const url = `${MYMEMORY_BASE}?q=${encodeURIComponent(text)}&langpair=en|fr`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = (await res.json()) as { responseData?: { translatedText?: string }; responseStatus?: number };
  if (!data.responseData?.translatedText) throw new Error(`MyMemory: no translation returned (status ${data.responseStatus})`);
  return data.responseData.translatedText;
}

/** Truncates at a word boundary and appends "…" if cut — used both to stay
 * under MyMemory's per-request character cap before translating, and to fit
 * the translated result into a card's quote/context space afterwards. */
export function truncateWords(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}
