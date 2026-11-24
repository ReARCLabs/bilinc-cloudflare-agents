/** One hit as the Bilinc memory block renders it in a search_context result (src/provider.ts renderHit). */
export interface MemoryHit {
  key: string;
  version: string | null;
  /** YYYY-MM-DD, or null when Bilinc did not say. */
  updated: string | null;
  value: string;
}

const ENTRY_RE = /<<<entry key=(\S+)(?: v=(\S+))? updated=(\S+)\n([\s\S]*?)\n>>>/g;

/** The hits in a search_context output; [] for anything else ("No results found.", an error, a non-string). */
export function parseHits(output: unknown): MemoryHit[] {
  if (typeof output !== "string") return [];
  return [...output.matchAll(ENTRY_RE)].map((m) => ({
    key: m[1]!,
    version: m[2] ?? null,
    updated: m[3] === "unknown" ? null : m[3]!,
    value: m[4]!,
  }));
}
