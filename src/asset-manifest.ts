// Resolves a transcript speaker's name to their entry in assets/manifest.json
// (portrait, role, team) — the same manifest STYLE.md describes as the single
// source of truth for card assets, so a transcript speaker and a hand-typed
// story use identical portraits/roles/colors.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ASSETS_DIR = join(__dirname, "..", "assets");
const MANIFEST_PATH = join(ASSETS_DIR, "manifest.json");

type ManifestPerson = { file: string; name: string; role: string; team: string; aliases: string[] };
type Manifest = { drivers: Record<string, ManifestPerson>; principals: Record<string, ManifestPerson> };

let cached: Manifest | null = null;
function loadManifest(): Manifest {
  if (!cached) cached = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  return cached;
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export type ResolvedPerson = {
  name: string;
  role: string;
  team: string;
  isDriver: boolean;
  /** Path relative to templates/, ready to drop into the card's `portrait` field. */
  portrait: string;
  /** Folder relative to assets/, e.g. "drivers/max_verstappen" — used by
   * randomPortraitFor to discover every portrait*.jpg variant on disk. */
  folder: string;
};

/** Matches a transcript speaker name (full name as parsed, e.g. "Max Verstappen")
 * against the manifest's drivers then principals, accent/case-insensitive,
 * checking both the entry's own name and its aliases. Returns null for
 * anyone not in the roster (guests, journalists, unlisted team staff). */
export function resolvePerson(speakerName: string): ResolvedPerson | null {
  const manifest = loadManifest();
  const key = normalize(speakerName);

  for (const [isDriver, table] of [[true, manifest.drivers], [false, manifest.principals]] as const) {
    for (const entry of Object.values(table)) {
      const candidates = [entry.name, ...(entry.aliases ?? [])].map(normalize);
      if (candidates.includes(key)) {
        const folder = entry.file.replace(/\/[^/]+$/, "");
        return { name: entry.name, role: entry.role, team: entry.team, isDriver, portrait: `../assets/${entry.file}`, folder };
      }
    }
  }
  return null;
}

/** Every file directly inside assets/<subdir> whose name matches `pattern`,
 * sorted for determinism. Returns [] (not a throw) for a missing/unreadable
 * directory, so callers can fall back gracefully — same philosophy as the
 * template's own "no asset yet -> placeholder" behavior (see STYLE.md). */
function listAssetVariants(subdir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(join(ASSETS_DIR, subdir))
      .filter((f) => pattern.test(f))
      .sort();
  } catch {
    return [];
  }
}

function pickRandom<T>(items: T[]): T | null {
  return items.length > 0 ? items[Math.floor(Math.random() * items.length)] : null;
}

let allSurnames: { surname: string; fullName: string }[] | null = null;
function loadAllSurnames(): { surname: string; fullName: string }[] {
  if (!allSurnames) {
    const manifest = loadManifest();
    allSurnames = [...Object.values(manifest.drivers), ...Object.values(manifest.principals)].map((entry) => {
      const parts = entry.name.trim().split(/\s+/);
      return { surname: normalize(parts[parts.length - 1]), fullName: entry.name };
    });
  }
  return allSurnames;
}

/** Every known driver/principal surname in the manifest — used to catch a
 * model naming a rostered person who has no business being in a given piece
 * of generated text: the wrong speaker bleeding in from a crowded batch, or
 * an invented name pulled from the model's own F1 knowledge rather than the
 * source transcript (a real failure mode observed with the local 7B model). */
export function allKnownSurnames(): string[] {
  return loadAllSurnames().map((s) => s.surname);
}

/** Scans free text for any known driver/principal's surname as a whole word
 * and returns their canonical full name (ready for resolvePerson) — a
 * deterministic, non-LLM fallback for when an article's own title is the
 * only signal left to name a subject from (see server.ts's
 * generateArticleStory, used only after the LLM step has already failed). */
export function findKnownSubject(text: string): string | null {
  const norm = normalize(text);
  for (const { surname, fullName } of loadAllSurnames()) {
    const re = new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(norm)) return fullName;
  }
  return null;
}

/** Picks a random background photo among every context_*.jpg actually
 * present for a team — not hardcoded to a fixed count, so dropping a new
 * assets/teams/<team>/context_5.jpg (etc.) in later adds variety immediately
 * with no code change. Falls back to context_1.jpg (template shows a plain
 * gradient if even that's missing — see STYLE.md's graceful fallback). */
export function randomBackgroundFor(team: string): string {
  const variants = listAssetVariants(`teams/${team}`, /^context_\d+\.(jpe?g|png|webp|avif)$/i);
  const chosen = pickRandom(variants) ?? "context_1.jpg";
  return `../assets/teams/${team}/${chosen}`;
}

/** Picks a random portrait among every portrait*.jpg actually present for a
 * person (portrait.jpg, portrait_2.jpg, ...) — same "discover what's on
 * disk" approach as randomBackgroundFor, so cards for someone with several
 * quotes in one run don't all reuse the identical photo, and adding more
 * variants later needs no code change. Falls back to the manifest's default
 * `portrait` path if the person's folder has nothing else (or is missing). */
export function randomPortraitFor(person: ResolvedPerson): string {
  const variants = listAssetVariants(person.folder, /^portrait(_\d+)?\.(jpe?g|png|webp|avif)$/i);
  const chosen = pickRandom(variants);
  return chosen ? `../assets/${person.folder}/${chosen}` : person.portrait;
}
