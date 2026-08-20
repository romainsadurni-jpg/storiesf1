// F1 2026 constructors — slugs match assets/manifest.json (no hyphens,
// different from f1-editorial-os's slugs), names match how F1.com's "What
// the teams said" articles actually write each team as a section header.

export type Team = { slug: string; name: string };

export const TEAMS: Team[] = [
  { slug: "mclaren", name: "McLaren" },
  { slug: "ferrari", name: "Ferrari" },
  { slug: "redbull", name: "Red Bull" },
  { slug: "mercedes", name: "Mercedes" },
  { slug: "astonmartin", name: "Aston Martin" },
  { slug: "williams", name: "Williams" },
  { slug: "audi", name: "Audi" },
  { slug: "alpine", name: "Alpine" },
  { slug: "haas", name: "Haas" },
  { slug: "racingbulls", name: "Racing Bulls" },
  { slug: "cadillac", name: "Cadillac" },
];
