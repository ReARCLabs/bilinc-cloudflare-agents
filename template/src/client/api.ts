import type { BilincHealthState } from "bilinc-cloudflare-agents";

export type GateState = "unlocked" | "locked" | "token_too_short" | "too_many_attempts";

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

/** The session cookie is HttpOnly, so this gated call is how the page learns whether it is unlocked. */
export async function fetchHealth(): Promise<{ gate: GateState; state?: BilincHealthState }> {
  const res = await fetch("/api/health", { credentials: "same-origin" });
  if (res.status === 401) return { gate: "locked" };
  if (await isTokenTooShort(res)) return { gate: "token_too_short" };
  if (!res.ok) return { gate: "unlocked" };
  const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
  return { gate: "unlocked", state: isHealthState(body?.state) ? body.state : undefined };
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
  if (res.status === 429) {
    // A missing or empty header would be Number("") === 0; leave it undefined so the 600 s fallback shows.
    const retryAfterSeconds = Number(res.headers.get("Retry-After")?.trim() || NaN);
    return { ok: false, gate: "too_many_attempts", retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined };
  }
  if (res.status === 401) return { ok: false, gate: "locked" };
  return { ok: false, gate: "locked", serverError: true };
}
