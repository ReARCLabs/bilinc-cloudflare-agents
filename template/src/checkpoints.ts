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

/**
 * The History list: two free reads, one after the other (listSnapshots, then a one-entry list for
 * the total). Never throws and never writes. An empty key or an invalid namespace answers without
 * a request.
 */
export async function readCheckpoints(env: Pick<Env, "BILINC_API_KEY" | "BILINC_NAMESPACE">): Promise<CheckpointsBody> {
  const apiKey = typeof env.BILINC_API_KEY === "string" ? env.BILINC_API_KEY.trim() : "";
  if (!apiKey) return failed("key_missing");
  let bilinc: Bilinc;
  try {
    bilinc = createBilinc({ apiKey, namespace: env.BILINC_NAMESPACE });
  } catch {
    return failed("namespace_invalid");
  }
  try {
    const snapshots = await bilinc.client.listSnapshots({ limit: CHECKPOINT_LIST_LIMIT });
    const page = await bilinc.client.list({ limit: 1, values: "none" });
    return {
      state: "ok",
      checkpoints: snapshots.map(({ id, label, createdAt, totalEntries }) => ({ id, label, createdAt, totalEntries })),
      now: { total: page.total },
    };
  } catch (error) {
    if (isBilincError(error) && error.code === "missing_api_key") return failed("key_missing");
    if (isBilincError(error) && error.code === "invalid_api_key") return failed("key_invalid");
    return failed("unreachable");
  }
}
