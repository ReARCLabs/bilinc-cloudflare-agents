export const DEFAULT_BASE_URL = "https://bilinc.space";
export const API_PATH = "/api/cloud";

export const NAMESPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_NAMESPACE = "default";
/** Stored key = cf.<namespace>.<sdkKey>. */
export const KEY_PREFIX = (ns: string): string => `cf.${ns}.`;
export const SDK_KEY_RE = /^[a-z0-9-]{1,128}$/;
/** The SDK key under `prefix`, or null for a key that is not ours or not an SDK key. */
export function ownSuffix(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const suffix = key.slice(prefix.length);
  return SDK_KEY_RE.test(suffix) ? suffix : null;
}
export const SNAPSHOT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export const SOURCE = "cloudflare-agent";
export const DEFAULT_LABEL = "memory";

export const DEFAULT_PROFILE = "balanced";
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 25;
export const RECALL_LIMIT = (limit: number): number => Math.min(100, limit * 4);

export const DEFAULT_MAX_CHARS = 6000;
export const MAX_VALUE_CHARS = 2000;
export const MAX_QUERY_CHARS = 4096;
export const MAX_REASON_CHARS = 512;
export const RESERVED_REASON_PREFIX = "dream:";
export const MAX_LABEL_CHARS = 128;
export const MAX_EXPECTED_VERSION_CHARS = 128;
/** A longer sessionId is sent as "sha256:<hex>". */
export const MAX_SESSION_ID_CHARS = 256;

export const SUMMARY_LIST_LIMIT = 10;
export const SNAPSHOT_LIST_DEFAULT = 20;
export const SNAPSHOT_LIST_MAX = 100;
export const HISTORY_LIMIT = 20;

export const TIMEOUT_FREE_READ_MS = 3000;
export const TIMEOUT_RECALL_MS = 15000;
export const TIMEOUT_WRITE_MS = 20000;
export const HEALTH_TIMEOUT_MS = 3000;

export const READ_MAX_ATTEMPTS = 3;
/** Waits before retry 1 and retry 2 of a free read. No jitter. */
export const READ_BACKOFF_MS = [200, 600] as const;
/** One repeat with the same Idempotency-Key after idempotency_conflict with details.inFlight. */
export const INFLIGHT_REPEAT_DELAY_MS = 500;

export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 60_000;
export const BREAKER_RETRY_AFTER_CAP_MS = 600_000;

/**
 * Non-enumerable property of a createBilinc() instance: a function that says whether its breaker is
 * open. Internal; the tools read it. A registry symbol, so two copies of the package still agree.
 */
export const BREAKER_OPEN = Symbol.for("bilinc-cloudflare-agents/breakerOpen");

/** Billable calls (recall, commit, forget, createSnapshot, rollback) per sliding window. */
export const RATE_CAP = 20;
export const RATE_WINDOW_MS = 60_000;

/** + crypto.randomUUID(); value { snapshotId, confirmationToken, reason, expiresAt }. */
export const ROLLBACK_PREVIEW_STORE_PREFIX = "bilinc:rollbackPreview:";
