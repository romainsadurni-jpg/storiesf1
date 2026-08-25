// Non-constructor organizations recognized as a story subject when an
// article is institutional rather than about a person or a team — kept
// separate from teams.ts (F1 2026 constructors only, also driving
// transcript.ts's per-team "What the teams said" synthesis) so growing
// this list can't affect that unrelated logic.

export type Org = {
  slug: string;
  name: string;
  /** Backing color behind the logo circle (quote-card.html's `.is-logo`
   * padding) when the logo file itself is an opaque image with its own
   * background baked in, so that backing blends instead of showing as a
   * white margin — sampled directly from assets/orgs/<slug>/logo.jpg's own
   * background pixel. Omit for a transparent-background logo (default
   * white backing still applies). */
  logoBackground?: string;
};

export const ORGS: Org[] = [{ slug: "fia", name: "FIA", logoBackground: "#012C5F" }];
