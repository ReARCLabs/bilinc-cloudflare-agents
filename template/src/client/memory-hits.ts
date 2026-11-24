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

export type Segment = { kind: "text"; text: string } | { kind: "chip"; hit: MemoryHit };

/** Sentences, with their punctuation and any closing quote; joined back together they give the text exactly. */
const SENTENCE_RE = /[^.!?]*[.!?]+["')\]]*|[^.!?]+/g;

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "your", "what", "have", "about", "they", "them", "their", "there", "were", "been",
  "will", "would", "should", "could", "does", "into", "than", "then", "when", "which", "also", "just", "like", "more",
  "some", "user", "users",
]);

function words(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w));
}

/**
 * Splits the answer into text and memory chips. A hit's chip goes right after the first sentence
 * that shares a word of four or more letters (not a stop word) with the hit's value; a hit no
 * sentence backs gets no chip. One chip per key.
 */
export function placeChips(text: string, hits: MemoryHit[]): Segment[] {
  const sentences = text.match(SENTENCE_RE) ?? [];
  const at = new Map<number, MemoryHit[]>();
  const used = new Set<string>();
  for (const hit of hits) {
    if (used.has(hit.key)) continue;
    const hitWords = words(hit.value);
    const index = sentences.findIndex((sentence) => {
      const lower = sentence.toLowerCase();
      return hitWords.some((w) => lower.includes(w));
    });
    if (index === -1) continue;
    used.add(hit.key);
    at.set(index, [...(at.get(index) ?? []), hit]);
  }
  const out: Segment[] = [];
  sentences.forEach((sentence, i) => {
    const chips = at.get(i);
    if (!chips) {
      out.push({ kind: "text", text: sentence });
      return;
    }
    const body = sentence.trimEnd();
    out.push({ kind: "text", text: body });
    for (const hit of chips) out.push({ kind: "chip", hit });
    if (body.length < sentence.length) out.push({ kind: "text", text: sentence.slice(body.length) });
  });
  return out;
}
