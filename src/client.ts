import {
  DEFAULT_LIMIT,
  DEFAULT_PROFILE,
  INFLIGHT_REPEAT_DELAY_MS,
  MAX_EXPECTED_VERSION_CHARS,
  MAX_LABEL_CHARS,
  MAX_QUERY_CHARS,
  MAX_REASON_CHARS,
  MAX_SESSION_ID_CHARS,
  READ_BACKOFF_MS,
  READ_MAX_ATTEMPTS,
  RECALL_LIMIT,
  RESERVED_REASON_PREFIX,
  SNAPSHOT_ID_RE,
  SNAPSHOT_LIST_DEFAULT,
  SNAPSHOT_LIST_MAX,
  TIMEOUT_FREE_READ_MS,
  TIMEOUT_RECALL_MS,
  TIMEOUT_WRITE_MS,
} from "./constants";
import { BilincError } from "./errors";
import type { BilincOp } from "./errors";
import type { Guard } from "./guard";
import { attempt, breakerEffect, hasNoDefiniteAnswer, isReadRetryable } from "./transport";
import type { AttemptFailure, RequestSpec } from "./transport";

export type BilincProfile = "fast" | "balanced" | "verified" | "deep";

export interface SnapshotInfo { id: string; label: string | null; createdAt: string; totalEntries: number }
export interface RecallHit { key: string; value: string; entryVersion: string | null; updatedAt: string | null; source: string | null }
export interface ListResult { total: number; entries: { key: string; updatedAt: string; entryVersion: string }[]; nextCursor: string | null }
export interface HistoryResult {
  key: string;
  exists: boolean;
  truncated: boolean;
  entries: { op: string; at: string; reason: string | null; source: string | null; before?: unknown; after?: unknown }[];
}
export interface CommitResult { entryVersion: string | null; affectedKeys: string[]; warnings: { code: string; rule: string; field: string }[] }
export interface DiffResult {
  counts: { added: number; modified: number; removed: number };
  added: string[];
  modified: string[];
  removed: string[];
  truncated: boolean;
}
export interface RollbackPreview {
  snapshotId: string;
  counts: { create: number; update: number; remove: number };
  createKeys: string[];
  updateKeys: string[];
  removeKeys: string[];
  truncated: boolean;
  confirmationToken: string;
  confirmationExpiresAt: string;
}
export interface RollbackResult { snapshotId: string; counts: { created: number; updated: number; deleted: number } }
export interface ForgetResult { key: string; removed: boolean }
export interface BilincStatus {
  credits: { availableTotalCredits: number | null; monthlyRemainingCredits: number | null } | null;
  capabilities: Record<string, unknown>;
  recallProfiles: string[];
  /** `status.runtime.version`: the deployed sidecar version, or null when the server does not report it. */
  runtimeVersion: string | null;
}

/** Not constructible by users: the only instance is createBilinc().client. Keys are full keys. */
export interface BilincClient {
  status(): Promise<BilincStatus>;
  commit(i: { key: string; value: string; source?: string; sessionId?: string; metadata?: Record<string, unknown> }): Promise<CommitResult>;
  recall(i: { query: string; profile?: BilincProfile; limit?: number }): Promise<RecallHit[]>;
  list(i?: { prefix?: string; order?: "key" | "newest" | "oldest"; values?: "full" | "preview" | "none"; limit?: number }): Promise<ListResult>;
  history(i: { key: string; values?: "full" | "preview" | "none"; limit?: number }): Promise<HistoryResult>;
  createSnapshot(i?: { label?: string }): Promise<SnapshotInfo>;
  listSnapshots(i?: { limit?: number }): Promise<SnapshotInfo[]>;
  diff(i: { fromSnapshotId: string; includeValues?: boolean; limit?: number }): Promise<DiffResult>;
  rollbackPreview(i: { snapshotId: string; reason: string; limit?: number }): Promise<RollbackPreview>;
  rollback(i: { snapshotId: string; reason: string; confirmationToken: string }): Promise<RollbackResult>;
  forget(i: { key: string; reason: string; expectedVersion?: string }): Promise<ForgetResult>;
}

/** Internal wiring for createClient(); not exported from the package entry. */
export interface ClientConfig {
  apiKey: string;
  /** Already checked to be https, without a trailing slash. */
  baseUrl: string;
  guard: Guard;
  /** Called exactly once per failed call, before it rejects. Callers never call it again. */
  onError: (error: BilincError, op: BilincOp) => void;
}

type OpClass = "free" | "recall" | "write";

const TIMEOUT_MS: Record<OpClass, number> = {
  free: TIMEOUT_FREE_READ_MS,
  recall: TIMEOUT_RECALL_MS,
  write: TIMEOUT_WRITE_MS,
};

class ShapeError extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- response readers: a wrong shape throws ShapeError; any throw from a reader becomes bad_response ----

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ShapeError();
  return v as Record<string, unknown>;
}
function arr(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError();
  return v;
}
function str(v: unknown): string {
  if (typeof v !== "string") throw new ShapeError();
  return v;
}
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strOr = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Epoch seconds to ISO, or null when it is not a number or out of Date's range. */
function isoFromEpochSeconds(v: unknown): string | null {
  if (typeof v !== "number") return null;
  const date = new Date(v * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function snapshotInfo(v: unknown): SnapshotInfo {
  const s = obj(v);
  return { id: str(s.id), label: strOrNull(s.label), createdAt: strOr(s.createdAt, ""), totalEntries: count(s.totalEntries) };
}

function recordKeys(v: unknown): string[] {
  return arr(v).flatMap((item) => (isObj(item) && typeof item.key === "string" ? [item.key] : []));
}

const map = {
  status(b: Record<string, unknown>): BilincStatus {
    const c = b.credits;
    return {
      credits: isObj(c) ? { availableTotalCredits: numOrNull(c.availableTotalCredits), monthlyRemainingCredits: numOrNull(c.monthlyRemainingCredits) } : null,
      capabilities: isObj(b.capabilities) ? b.capabilities : {},
      recallProfiles: Array.isArray(b.recallProfiles) ? strings(b.recallProfiles) : [],
      runtimeVersion: isObj(b.runtime) ? strOrNull(b.runtime.version) : null,
    };
  },
  commit(b: Record<string, unknown>): CommitResult {
    return {
      entryVersion: strOrNull(b.entryVersion),
      affectedKeys: Array.isArray(b.affected_keys) ? strings(b.affected_keys) : [],
      warnings: Array.isArray(b.warnings)
        ? b.warnings.flatMap((w) =>
            isObj(w) && typeof w.code === "string" && typeof w.rule === "string" && typeof w.field === "string"
              ? [{ code: w.code, rule: w.rule, field: w.field }]
              : [],
          )
        : [],
    };
  },
  /** snake_case items; an unexpected shape is no results, never an error. */
  recall(b: Record<string, unknown>): RecallHit[] {
    if (!Array.isArray(b.results)) return [];
    return b.results.flatMap((item): RecallHit[] => {
      if (!isObj(item) || typeof item.key !== "string" || item.value === undefined) return [];
      return [
        {
          key: item.key,
          value: typeof item.value === "string" ? item.value : JSON.stringify(item.value),
          entryVersion: strOrNull(item.entry_version),
          updatedAt: isoFromEpochSeconds(item.updated_at),
          source: strOrNull(item.source),
        },
      ];
    });
  },
  list(b: Record<string, unknown>): ListResult {
    const entries = arr(b.entries).flatMap((e) =>
      isObj(e) && typeof e.key === "string" ? [{ key: e.key, updatedAt: strOr(e.updatedAt, ""), entryVersion: strOr(e.entryVersion, "") }] : [],
    );
    return { total: typeof b.total === "number" ? b.total : entries.length, entries, nextCursor: strOrNull(b.nextCursor) };
  },
  history(b: Record<string, unknown>, key: string): HistoryResult {
    return {
      key: strOr(b.key, key),
      exists: b.exists === true,
      truncated: b.truncated === true,
      entries: arr(b.entries).flatMap((e) =>
        isObj(e) && typeof e.op === "string"
          ? [
              {
                op: e.op,
                at: strOr(e.at, ""),
                reason: strOrNull(e.reason),
                source: strOrNull(e.source),
                ...("before" in e ? { before: e.before } : {}),
                ...("after" in e ? { after: e.after } : {}),
              },
            ]
          : [],
      ),
    };
  },
  createSnapshot(b: Record<string, unknown>): SnapshotInfo {
    return snapshotInfo(b.snapshot);
  },
  listSnapshots(b: Record<string, unknown>): SnapshotInfo[] {
    return arr(b.snapshots).flatMap((s) => (isObj(s) && typeof s.id === "string" ? [snapshotInfo(s)] : []));
  },
  /** snake_case body; records are {key} without values. */
  diff(b: Record<string, unknown>): DiffResult {
    const counts = isObj(b.counts) ? b.counts : {};
    return {
      counts: { added: count(counts.added), modified: count(counts.modified), removed: count(counts.removed) },
      added: recordKeys(b.added),
      modified: recordKeys(b.modified),
      removed: recordKeys(b.removed),
      truncated: b.truncated === true,
    };
  },
  rollbackPreview(b: Record<string, unknown>): RollbackPreview {
    const counts = obj(b.counts);
    return {
      snapshotId: str(b.snapshotId),
      counts: { create: count(counts.create), update: count(counts.update), remove: count(counts.remove) },
      createKeys: strings(b.createKeys),
      updateKeys: strings(b.updateKeys),
      removeKeys: strings(b.removeKeys),
      truncated: b.truncated === true,
      confirmationToken: str(b.confirmationToken),
      confirmationExpiresAt: str(b.confirmationExpiresAt),
    };
  },
  rollback(b: Record<string, unknown>): RollbackResult {
    const counts = obj(b.counts);
    return { snapshotId: str(b.snapshotId), counts: { created: count(counts.created), updated: count(counts.updated), deleted: count(counts.deleted) } };
  },
  forget(b: Record<string, unknown>): ForgetResult {
    return { key: str(b.key), removed: b.removed === true };
  },
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createClient(config: ClientConfig): BilincClient {
  const { apiKey, baseUrl, guard } = config;

  function fail(op: BilincOp, error: BilincError): BilincError {
    try {
      config.onError(error, op);
    } catch {
      // A throwing onError must not change the call's outcome.
    }
    return error;
  }

  function invalid(op: BilincOp, field: string, reason: string): BilincError {
    return fail(op, new BilincError({ code: "invalid_request", status: 0, details: { field, reason } }));
  }

  /** The server trims, then checks length and the reserved prefix (its isDreamReason trims too). Mirror it. */
  function checkReason(op: BilincOp, reason: unknown): string {
    const value = typeof reason === "string" ? reason.trim() : "";
    if (!value) throw invalid(op, "reason", "required");
    if (value.length > MAX_REASON_CHARS) throw invalid(op, "reason", "too_long");
    if (value.startsWith(RESERVED_REASON_PREFIX)) throw invalid(op, "reason", "reserved_reason");
    return value;
  }

  function checkOptional(op: BilincOp, field: string, value: string | undefined, max: number): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) throw invalid(op, field, "empty");
    if (trimmed.length > max) throw invalid(op, field, "too_long");
    return trimmed;
  }

  function checkSnapshotId(op: BilincOp, field: string, id: unknown): string {
    if (typeof id !== "string" || !SNAPSHOT_ID_RE.test(id)) throw invalid(op, field, "pattern");
    return id;
  }

  async function run<T>(
    op: BilincOp,
    cls: OpClass,
    request: Pick<RequestSpec, "method" | "path" | "body">,
    read: (body: Record<string, unknown>) => T,
  ): Promise<T> {
    const refused = guard.admit(cls !== "free");
    if (refused) throw fail(op, new BilincError({ code: refused, status: 0 }));

    const spec: RequestSpec = {
      ...request,
      timeoutMs: TIMEOUT_MS[cls],
      ...(cls === "free" ? {} : { idempotencyKey: crypto.randomUUID() }),
    };

    let attempts = 0;
    let repeated = false;
    for (;;) {
      attempts += 1;
      const result = await attempt(baseUrl, apiKey, spec);
      let failure: AttemptFailure;
      if (result.ok) {
        let mapped: { value: T } | undefined;
        try {
          mapped = { value: read(result.body) };
        } catch {
          // A ShapeError, or anything else a reader throws: the body is not one this client can use.
          mapped = undefined;
        }
        if (mapped !== undefined) {
          guard.record({ kind: "reset" });
          return mapped.value;
        }
        failure = { kind: "bad_shape", code: "bad_response", status: result.status, requestId: result.requestId };
      } else {
        failure = result.failure;
      }

      // A 503 with Retry-After (the maintenance page) is not retried: it opens the breaker for that time instead.
      if (cls === "free" && attempts < READ_MAX_ATTEMPTS && isReadRetryable(failure) && failure.retryAfterMs === undefined) {
        await sleep(READ_BACKOFF_MS[attempts - 1] ?? 0);
        continue;
      }
      const inFlight =
        failure.kind === "json_error" && failure.code === "idempotency_conflict" && isObj(failure.details) && failure.details.inFlight === true;
      if (cls === "write" && !repeated && inFlight) {
        repeated = true;
        await sleep(INFLIGHT_REPEAT_DELAY_MS);
        continue;
      }

      guard.record(breakerEffect(failure));
      throw fail(
        op,
        new BilincError({
          code: failure.code,
          status: failure.status,
          retryable: cls === "write" ? false : isReadRetryable(failure),
          // Still in flight after the one repeat: the original request may yet be applied.
          outcomeUnknown: cls === "write" && (hasNoDefiniteAnswer(failure) || inFlight),
          ...(failure.requestId !== undefined ? { requestId: failure.requestId } : {}),
          ...(failure.details !== undefined ? { details: failure.details } : {}),
        }),
      );
    }
  }

  return {
    status: () => run("status", "free", { method: "GET", path: "/status" }, map.status),

    async commit(i) {
      if (i.sessionId != null && typeof i.sessionId !== "string") throw invalid("commit", "sessionId", "type");
      const trimmed = i.sessionId?.trim();
      const sessionId = !trimmed
        ? undefined
        : trimmed.length > MAX_SESSION_ID_CHARS
          ? `sha256:${await sha256Hex(trimmed)}`
          : trimmed;
      return run(
        "commit",
        "write",
        {
          method: "POST",
          path: "/memory/commit",
          body: { key: i.key, value: i.value, source: i.source, sessionId, metadata: i.metadata },
        },
        map.commit,
      );
    },

    async recall(i) {
      if (typeof i?.query !== "string") throw invalid("recall", "query", "required");
      return run(
        "recall",
        "recall",
        {
          method: "POST",
          path: "/memory/recall",
          body: { query: i.query.slice(0, MAX_QUERY_CHARS), profile: i.profile ?? DEFAULT_PROFILE, limit: i.limit ?? RECALL_LIMIT(DEFAULT_LIMIT) },
        },
        map.recall,
      );
    },

    list(i = {}) {
      return run("list", "free", { method: "POST", path: "/memory/list", body: { prefix: i.prefix, order: i.order, values: i.values, limit: i.limit } }, map.list);
    },

    history(i) {
      return run("history", "free", { method: "POST", path: "/memory/history", body: { key: i.key, values: i.values, limit: i.limit } }, (b) =>
        map.history(b, i.key),
      );
    },

    async createSnapshot(i = {}) {
      const label = checkOptional("createSnapshot", "label", i.label, MAX_LABEL_CHARS);
      return run("createSnapshot", "write", { method: "POST", path: "/memory/snapshots", body: { label, metadata: {} } }, map.createSnapshot);
    },

    async listSnapshots(i = {}) {
      const limit = i.limit ?? SNAPSHOT_LIST_DEFAULT;
      if (!Number.isInteger(limit) || limit < 1 || limit > SNAPSHOT_LIST_MAX) throw invalid("listSnapshots", "limit", "range");
      return run("listSnapshots", "free", { method: "GET", path: `/memory/snapshots?limit=${limit}` }, map.listSnapshots);
    },

    async diff(i) {
      const fromSnapshotId = checkSnapshotId("diff", "fromSnapshotId", i.fromSnapshotId);
      return run(
        "diff",
        "free",
        { method: "POST", path: "/memory/diff", body: { fromSnapshotId, includeValues: i.includeValues ?? false, limit: i.limit } },
        map.diff,
      );
    },

    async rollbackPreview(i) {
      const snapshotId = checkSnapshotId("rollbackPreview", "snapshotId", i.snapshotId);
      const reason = checkReason("rollbackPreview", i.reason);
      return run("rollbackPreview", "free", { method: "POST", path: "/memory/rollback/preview", body: { snapshotId, reason, limit: i.limit } }, map.rollbackPreview);
    },

    async rollback(i) {
      const snapshotId = checkSnapshotId("rollback", "snapshotId", i.snapshotId);
      const reason = checkReason("rollback", i.reason);
      if (typeof i.confirmationToken !== "string" || !i.confirmationToken.trim()) throw invalid("rollback", "confirmationToken", "required");
      return run(
        "rollback",
        "write",
        { method: "POST", path: "/memory/rollback", body: { snapshotId, reason, confirmationToken: i.confirmationToken } },
        map.rollback,
      );
    },

    async forget(i) {
      const reason = checkReason("forget", i.reason);
      const expectedVersion = checkOptional("forget", "expectedVersion", i.expectedVersion, MAX_EXPECTED_VERSION_CHARS);
      return run("forget", "write", { method: "POST", path: "/memory/forget", body: { key: i.key, reason, expectedVersion } }, map.forget);
    },
  };
}
