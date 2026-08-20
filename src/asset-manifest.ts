// Resolves a transcript speaker's name to their entry in assets/manifest.json
// (portrait, role, team) — the same manifest STYLE.md describes as the single
// source of truth for card assets, so a transcript speaker and a hand-typed
// story use identical portraits/roles/colors.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_PATH = join(__dirname, "..", "assets", "manifest.json");

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
        return { name: entry.name, role: entry.role, team: entry.team, isDriver, portrait: `../assets/${entry.file}` };
      }
    }
  }
  return null;
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

const CONTEXT_VARIANTS = 4;

/** A team's background context photo, rotating deterministically across the
 * 4 available variants per team so consecutive cards for the same team don't
 * all reuse the identical background. */
export function backgroundFor(team: string, seed: number): string {
  const variant = (Math.abs(seed) % CONTEXT_VARIANTS) + 1;
  return `../assets/teams/${team}/context_${variant}.jpg`;
}
