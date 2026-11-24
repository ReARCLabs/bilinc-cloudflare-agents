// Model allowlist and per-chat choice. Pure: no Worker or React import, so the page imports it too.

/** Reasoning effort levels Workers AI takes as `reasoning_effort`. */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** The model a turn runs on, after validation. `effort` is null for a model that takes none. */
export interface ModelChoice {
  model: string;
  effort: Effort | null;
}

/** One validated entry of the MODELS var. */
export interface ModelEntry {
  id: string;
  label: string;
  note: string;
  tag: string;
  /** Effort levels in order, or null when the model takes no reasoning effort. */
  effort: Effort[] | null;
}

/** The allowlist the Worker enforces. `defaultId` is MODEL and is always in `models`. */
export interface ModelsConfig {
  defaultId: string;
  models: ModelEntry[];
}

/** Agent state: the chat's stored choice, null until its first turn. Only the server writes it. */
export interface AgentUiState {
  model: string | null;
  effort: Effort | null;
}

export const INITIAL_UI_STATE: AgentUiState = { model: null, effort: null };

const MODEL_ID_RE = /^@cf\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** "@cf/openai/gpt-oss-120b" → "gpt-oss-120b". */
export function shortLabel(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function entryFrom(raw: unknown): ModelEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!MODEL_ID_RE.test(id)) return null;
  const listed = Array.isArray(r.effort) ? EFFORT_LEVELS.filter((level) => (r.effort as unknown[]).includes(level)) : [];
  return {
    id,
    label: text(r.label, 40) || shortLabel(id),
    note: text(r.note, 80),
    tag: text(r.tag, 16),
    effort: listed.length > 0 ? listed : null,
  };
}

/**
 * MODELS as wrangler passes it: an array (a JSON var in wrangler.jsonc) or a JSON string
 * (`--var`, `.dev.vars`, the dashboard). Entries without a `@cf/<author>/<model>` id and repeated
 * ids are dropped. MODEL is always in the result; when MODELS lacks it, it is added first, with
 * no reasoning effort.
 */
export function parseModels(raw: unknown, defaultModel: unknown): ModelsConfig {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  const models: ModelEntry[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const entry = entryFrom(item);
    if (entry && !models.some((m) => m.id === entry.id)) models.push(entry);
  }
  const defaultId = typeof defaultModel === "string" ? defaultModel.trim() : "";
  if (!models.some((m) => m.id === defaultId)) models.unshift({ id: defaultId, label: shortLabel(defaultId), note: "", tag: "", effort: null });
  return { defaultId, models };
}

/** "medium" when the model lists it, else its first level; null for a model without effort. */
export function defaultEffort(entry: ModelEntry): Effort | null {
  if (!entry.effort) return null;
  return entry.effort.includes("medium") ? "medium" : entry.effort[0]!;
}

/**
 * The choice a turn runs on. A request that names a model gets it only if MODELS lists it, else
 * MODEL; a request that names none keeps the chat's stored choice while MODELS still lists it.
 * Effort follows the same rule, and is null for a model that lists no levels.
 */
export function resolveChoice(body: Record<string, unknown> | undefined, config: ModelsConfig, stored: AgentUiState | undefined): ModelChoice {
  const find = (id: unknown) => config.models.find((m) => m.id === id);
  const fallback = find(config.defaultId)!;
  const asked = body !== undefined && "model" in body;
  const entry = (asked ? find(body?.model) : find(stored?.model)) ?? fallback;
  if (!entry.effort) return { model: entry.id, effort: null };
  const wanted = body !== undefined && "effort" in body ? body.effort : stored?.model === entry.id ? stored?.effort : undefined;
  return { model: entry.id, effort: isEffort(wanted) && entry.effort.includes(wanted) ? wanted : defaultEffort(entry) };
}
