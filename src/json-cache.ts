// Generic TTL file cache — local stand-in for f1-editorial-os's
// prisma.statCache (Postgres), since this project has no database.
// One JSON file per key under data/cache/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = join(__dirname, "..", "data", "cache");

function keyPath(key: string): string {
  // ":" is invalid in a Windows filename (reserved for drive letters) —
  // exclude it from the "safe" set, not just from the replacement pattern.
  const safe = key.replace(/[^a-z0-9_-]+/gi, "_");
  return join(CACHE_DIR, `${safe}.json`);
}

export async function cachedJson<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const path = keyPath(key);
  if (existsSync(path)) {
    try {
      const { fetchedAt, data } = JSON.parse(readFileSync(path, "utf-8")) as { fetchedAt: number; data: T };
      if ((Date.now() - fetchedAt) / 1000 < ttlSeconds) return data;
    } catch {
      // fall through and refetch
    }
  }

  try {
    const data = await fetcher();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), data }), "utf-8");
    return data;
  } catch (e) {
    // Serve stale cache rather than failing outright, same rationale as
    // f1-editorial-os's cachedJson (jolpica.ts) / cachedSeasonEventOptions (fia.ts).
    if (existsSync(path)) {
      const { data } = JSON.parse(readFileSync(path, "utf-8")) as { data: T };
      return data;
    }
    throw e;
  }
}
