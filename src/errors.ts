/** The `op` passed to `onError` and `noticeFor`. */
export type BilincOp =
  | "status"
  | "list"
  | "recall"
  | "commit"
  | "history"
  | "createSnapshot"
  | "listSnapshots"
  | "diff"
  | "rollbackPreview"
  | "rollback"
  | "forget";

const BRAND = Symbol.for("bilinc-cloudflare-agents/BilincError");

/** Every notice the package can show the model. Other modules import these; never inline copies. */
export const NOTICES = {
  keyInvalid: "Bilinc API key is missing or invalid",
  creditsExhausted: "Bilinc credits exhausted",
  notOnPlan: "not available on this Bilinc plan",
  notOnPlanRecall: "not available on this Bilinc plan; use the fast or balanced profile",
  inputRejectedByBilinc: "input rejected by Bilinc",
  textTooLong:
    "not saved: text is longer than 2,000 characters; shorten it or split it into separate entries",
  invalidKey: "not saved: invalid key",
  secretDetected: "not saved: looks like a secret",
  secretRedacted: "saved, but a credential was removed from the text",
  notFound: "not found",
  checkpointNotFound: "checkpoint not found; call bilinc_checkpoints to list the ids that exist",
  noCheckpoints:
    "No checkpoints exist yet, so there is nothing to diff against or roll back to. Use bilinc_history to read earlier values of an entry, or bilinc_checkpoint to create a checkpoint now.",
  commitRefused: "not saved: Bilinc refused to overwrite this entry",
  entryChanged: "the entry changed; search again",
  requestConflict: "request conflict",
  previewExpired: "preview expired, run it again",
  busy: "Bilinc memory is busy; try again",
  outcomeUnknown: "outcome unknown; check history before trying again",
  unavailable: "Bilinc memory is unavailable right now",
  runPreviewFirst: "run the preview first",
  olderCheckpoints: "older checkpoints may exist; call again with a larger limit (max 100)",
} as const;

/** `input rejected: <field>` or `input rejected: <field> (<reason>)`. */
export function inputRejected(field: string, reason?: string): string {
  return reason ? `input rejected: ${field} (${reason})` : `input rejected: ${field}`;
}

export interface BilincErrorInit {
  code: string;
  status: number;
  retryable?: boolean;
  outcomeUnknown?: boolean;
  requestId?: string;
  details?: unknown;
}

export class BilincError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  outcomeUnknown: boolean;
  requestId?: string;
  details?: unknown;

  constructor(init: BilincErrorInit) {
    super(`Bilinc request failed: ${init.code}`);
    this.name = "BilincError";
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.outcomeUnknown = init.outcomeUnknown ?? false;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.details !== undefined) this.details = init.details;
    Object.defineProperty(this, BRAND, { value: true });
  }
}

/** Brand check, so two copies of the package (or a bundler split) still agree. */
export function isBilincError(e: unknown): e is BilincError {
  return typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[BRAND] === true;
}

const FIELD_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const REASON_RE = /^[a-z0-9_]{1,64}$/;
const SNAPSHOT_FIELDS = new Set(["snapshotId", "fromSnapshotId"]);
/** Codes the client sets itself; never a server answer. */
const CLIENT_CODES = new Set(["network", "timeout", "bad_response", "circuit_open", "rate_capped"]);

function detailString(details: unknown, name: "field" | "reason" | "inFlight"): unknown {
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>)[name] : undefined;
}

/** The model-facing notice for a failed call. Never contains a raw body, a header or the key. */
export function noticeFor(error: unknown, op: BilincOp, ctx?: { expectedVersion?: boolean }): string {
  if (!isBilincError(error)) return NOTICES.unavailable;
  if (error.outcomeUnknown) return NOTICES.outcomeUnknown;
  switch (error.code) {
    case "missing_api_key":
    case "invalid_api_key":
      return NOTICES.keyInvalid;
    case "payment_required":
      return NOTICES.creditsExhausted;
    case "capability_not_entitled":
    case "entitlement_inactive":
      return op === "recall" ? NOTICES.notOnPlanRecall : NOTICES.notOnPlan;
    case "invalid_request": {
      const field = detailString(error.details, "field");
      if (typeof field !== "string" || !FIELD_RE.test(field)) return NOTICES.inputRejectedByBilinc;
      if (SNAPSHOT_FIELDS.has(field)) return NOTICES.checkpointNotFound;
      const reason = detailString(error.details, "reason");
      return inputRejected(field, typeof reason === "string" && REASON_RE.test(reason) ? reason : undefined);
    }
    case "secret_detected":
      return NOTICES.secretDetected;
    case "memory_not_found":
      return NOTICES.notFound;
    case "snapshot_not_found":
      return NOTICES.checkpointNotFound;
    case "version_conflict":
      if (op === "commit") return NOTICES.commitRefused;
      if (op === "forget" && ctx?.expectedVersion) return NOTICES.entryChanged;
      return NOTICES.requestConflict;
    case "state_changed_since_preview":
    case "rollback_confirmation_expired":
      return NOTICES.previewExpired;
    case "idempotency_conflict":
      return detailString(error.details, "inFlight") === true ? NOTICES.busy : NOTICES.requestConflict;
    case "memory_exists":
      return NOTICES.requestConflict;
    default:
      // Only a JSON 409 is a conflict; a non-JSON 409 page is `bad_response` and reads "unavailable".
      return error.status === 409 && !CLIENT_CODES.has(error.code) ? NOTICES.requestConflict : NOTICES.unavailable;
  }
}

/** Default `onError`: one line with the operation, the code and the requestId. Never the key or a body. */
export function defaultOnError(error: BilincError, op: string): void {
  console.warn(`[bilinc] ${op} failed: ${error.code}` + (error.requestId ? ` requestId=${error.requestId}` : ""));
}
