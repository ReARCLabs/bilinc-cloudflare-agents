import type { BilincHealthState } from "bilinc-cloudflare-agents";
import { parseModels, type ModelsConfig } from "../models";

export type GateState = "unlocked" | "locked" | "token_too_short" | "too_many_attempts";

/** What one /api/health check found: a gate state, or "failed" when it gave no usable answer. */
export type HealthCheck = GateState | "failed";

const HEALTH_STATES: readonly BilincHealthState[] = ["ok", "key_missing", "key_invalid", "namespace_invalid", "unreachable"];

function isHealthState(v: unknown): v is BilincHealthState {
  return typeof v === "string" && (HEALTH_STATES as readonly string[]).includes(v);
}

/** Only the Worker's own 503 `{"error":"access_token_too_short"}` means the token is too short; any other 503 (an edge page, an overload) is an ordinary failed answer. */
async function isTokenTooShort(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === "access_token_too_short";
}

/**
 * The session cookie is HttpOnly, so this gated call is how the page learns whether it is unlocked.
 * Any other failed answer (a 500, another 503) says nothing about the session, so it throws like a failed fetch.
 */
export async function fetchHealth(): Promise<{ gate: GateState; state?: BilincHealthState }> {
  const res = await fetch("/api/health", { credentials: "same-origin" });
  if (res.status === 401) return { gate: "locked" };
  if (await isTokenTooShort(res)) return { gate: "token_too_short" };
  if (!res.ok) throw new Error(`/api/health answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
  return { gate: "unlocked", state: isHealthState(body?.state) ? body.state : undefined };
}

/**
 * Whole seconds, at least 1, or undefined so the 600 s fallback shows. A missing, empty, zero or
 * malformed header ("0.5", "-5", "0x10", which Number() would accept) never reads "Try again in 0 seconds".
 */
function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get("Retry-After")?.trim();
  if (!raw || !/^\d{1,7}$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return seconds >= 1 ? seconds : undefined;
}

export type UnlockResult = { ok: boolean; gate: GateState; retryAfterSeconds?: number; serverError?: true };

/** Only a 401 means the passphrase was wrong; any other unexpected status is the agent's error (`serverError`). */
export async function unlock(passphrase: string): Promise<UnlockResult> {
  const res = await fetch("/api/unlock", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  if (res.ok) return { ok: true, gate: "unlocked" };
  if (await isTokenTooShort(res)) return { ok: false, gate: "token_too_short" };
  if (res.status === 429) return { ok: false, gate: "too_many_attempts", retryAfterSeconds: retryAfterSeconds(res) };
  if (res.status === 401) return { ok: false, gate: "locked" };
  return { ok: false, gate: "locked", serverError: true };
}

/** The model allowlist, or null when it cannot be read: the selector then stays hidden and the Worker runs MODEL. */
export async function fetchModels(): Promise<ModelsConfig | null> {
  try {
    const res = await fetch("/api/models", { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json()) as { default?: unknown; models?: unknown };
    if (typeof body.default !== "string" || !Array.isArray(body.models)) return null;
    return parseModels(body.models, body.default);
  } catch {
    return null;
  }
}
