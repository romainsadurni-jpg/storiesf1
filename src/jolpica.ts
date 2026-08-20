// Jolpica-F1 client — port of f1-editorial-os's lib/jolpica.ts, trimmed to
// what this project needs (current-season schedule + last/next race, used
// to find "the current GP" and to order events chronologically).

import { cachedJson } from "./json-cache";

const BASE = "https://api.jolpi.ca/ergast/f1";

export type RaceInfo = {
  season: string;
  round: string;
  raceName: string;
  circuit: string;
  date: string;
  time?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapRace(r: any): RaceInfo | null {
  if (!r) return null;
  return {
    season: r.season,
    round: r.round,
    raceName: r.raceName,
    circuit: r.Circuit?.circuitName ?? "",
    date: r.date,
    time: r.time,
  };
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}format=json`, {
    headers: { "User-Agent": "F1-Stories-Generator/1.0" },
  });
  if (!res.ok) throw new Error(`Jolpica ${res.status} on ${url}`);
  return res.json();
}

export async function getNextRace(): Promise<RaceInfo | null> {
  const d = await cachedJson("race:next", 30 * 60, () => fetchJson(`${BASE}/current/next/`));
  return mapRace(d?.MRData?.RaceTable?.Races?.[0]);
}

export async function getLastRace(): Promise<RaceInfo | null> {
  const d = await cachedJson("race:last", 60 * 60, () => fetchJson(`${BASE}/current/last/`));
  return mapRace(d?.MRData?.RaceTable?.Races?.[0]);
}

export async function getCurrentSchedule(): Promise<RaceInfo[]> {
  const d = await cachedJson("schedule:current", 6 * 60 * 60, () => fetchJson(`${BASE}/current/`));
  return (d?.MRData?.RaceTable?.Races ?? []).map(mapRace).filter((x: RaceInfo | null): x is RaceInfo => x !== null);
}
