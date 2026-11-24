import { createBilinc, isBilincError, type Bilinc, type BilincHealthState } from "bilinc-cloudflare-agents";

export interface CheckpointRow {
  id: string;
  label: string | null;
  createdAt: string;
  totalEntries: number;
}

/** What GET /api/checkpoints answers. `state` uses the banner states of /api/health. */
export interface CheckpointsBody {
  state: BilincHealthState;
  checkpoints: CheckpointRow[];
  /** The project's current entry count (project-wide, like each checkpoint's totalEntries). */
  now: { total: number } | null;
}

export const CHECKPOINT_LIST_LIMIT = 20;

const failed = (state: BilincHealthState): CheckpointsBody => ({ state, checkpoints: [], now: null });

/** How long one isolate reuses an answer: History opens and turn ends cannot flood Bilinc. */
export const CHECKPOINTS_CACHE_MS = 5_000;

/** Per isolate, per key and namespace: one Bilinc instance, and the latest answer (or the read in flight). */
const clients = new Map<string, Bilinc>();
const answers = new Map<string, { at: number; body: Promise<CheckpointsBody> }>();

/** Test hook: forget the cached instances and answers. */
export function resetCheckpointsCache(): void {
  clients.clear();
  answers.clear();
}

/**
 * The History list: two free reads, one after the other (listSnapshots, then a one-entry list for
 * the total; when only the total fails, `now` is null). Never throws and never writes. An empty key
 * or an invalid namespace answers without a request. Each isolate reuses its Bilinc instance and
 * answers repeat calls within CHECKPOINTS_CACHE_MS (failures too) from the first call's reads.
 */
export function readCheckpoints(env: Pick<Env, "BILINC_API_KEY" | "BILINC_NAMESPACE">): Promise<CheckpointsBody> {
  const apiKey = typeof env.BILINC_API_KEY === "string" ? env.BILINC_API_KEY.trim() : "";
  if (!apiKey) return Promise.resolve(failed("key_missing"));
  const cacheKey = `${apiKey}\u0000${String(env.BILINC_NAMESPACE)}`;
  let bilinc = clients.get(cacheKey);
  if (!bilinc) {
    try {
      bilinc = createBilinc({ apiKey, namespace: env.BILINC_NAMESPACE });
    } catch {
      return Promise.resolve(failed("namespace_invalid"));
    }
    clients.set(cacheKey, bilinc);
  }
  const now = Date.now();
  const cached = answers.get(cacheKey);
  if (cached && now - cached.at < CHECKPOINTS_CACHE_MS) return cached.body;
  const body = read(bilinc);
  answers.set(cacheKey, { at: now, body });
  return body;
}

async function read(bilinc: Bilinc): Promise<CheckpointsBody> {
  try {
    const snapshots = await bilinc.client.listSnapshots({ limit: CHECKPOINT_LIST_LIMIT });
    const checkpoints = snapshots.map(({ id, label, createdAt, totalEntries }) => ({ id, label, createdAt, totalEntries }));
    // The list is the answer; a failed count read only leaves out the "now" row.
    const total = await bilinc.client.list({ limit: 1, values: "none" }).then((page) => page.total, () => null);
    return { state: "ok", checkpoints, now: total === null ? null : { total } };
  } catch (error) {
    if (isBilincError(error) && error.code === "missing_api_key") return failed("key_missing");
    if (isBilincError(error) && error.code === "invalid_api_key") return failed("key_invalid");
    return failed("unreachable");
  }
}
