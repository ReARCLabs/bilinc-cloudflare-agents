// Model allowlist and per-chat choice. Pure: no Worker or React import, so the page imports it too.

/** Reasoning effort levels Workers AI takes as `reasoning_effort`. */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** The model a turn runs on, after validation. `effort` is null for a model that takes none. */
export interface ModelChoice {
  model: string;
  effort: Effort | null;
}
