import { API_PATH, BREAKER_OPEN_MS, BREAKER_RETRY_AFTER_CAP_MS } from "./constants";

export interface RequestSpec {
  method: "GET" | "POST";
  /** Path after `/api/cloud`, including any query string. */
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  timeoutMs: number;
}

/**
 * How one attempt failed. Every retry, outcome-unknown and breaker rule is derived from this,
 * never from the code alone (one code, `bad_response`, covers four kinds).
 */
export type FailureKind =
  | "not_sent" //      building the Request threw; fetch was never called
  | "network" //       fetch rejected
  | "timeout" //       our AbortSignal fired before the body was read
  | "redirect" //      any 3xx, or type "opaqueredirect"
  | "non_json_2xx" //  2xx whose body is not a JSON object
  | "non_json_4xx" //  4xx without the JSON error shape
  | "non_json_5xx" //  5xx without the JSON error shape
  | "bad_shape" //     JSON success of the wrong shape (set by the client's mapper)
  | "json_error"; //   the JSON error shape: a definite answer

export interface AttemptFailure {
  kind: FailureKind;
  code: string;
  status: number;
  requestId?: string;
  details?: unknown;
  /** Only on a non-JSON 503 with a Retry-After of at least 1 s: the breaker open time, already capped. */
  retryAfterMs?: number;
}

export type AttemptResult =
  | { ok: true; status: number; body: Record<string, unknown>; requestId?: string }
  | { ok: false; failure: AttemptFailure };

export type BreakerEffect =
  | { kind: "open"; openMs: number }
  | { kind: "count" }
  | { kind: "reset" }
  | { kind: "none" };

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const REQUEST_ID_RE = /^[\w.:-]{1,128}$/;
const OPENS_AT_ONCE = new Set(["payment_required", "missing_api_key", "invalid_api_key"]);
const UNKNOWN_OUTCOME_CODES = new Set(["mutation_outcome_unknown", "cloud_runtime_unavailable"]);

export function breakerEffect(f: AttemptFailure): BreakerEffect {
  switch (f.kind) {
    case "not_sent":
      return { kind: "none" };
    case "non_json_5xx":
      return f.retryAfterMs !== undefined ? { kind: "open", openMs: f.retryAfterMs } : { kind: "count" };
    case "json_error":
      if (OPENS_AT_ONCE.has(f.code)) return { kind: "open", openMs: BREAKER_OPEN_MS };
      if (UNKNOWN_OUTCOME_CODES.has(f.code)) return { kind: "count" };
      if (f.status === 429) return { kind: "count" };
      if (f.status >= 500 && f.code !== "capability_unavailable") return { kind: "count" };
      return { kind: "reset" };
    default:
      return { kind: "count" };
  }
}

/** Free reads retry only after these. */
export function isReadRetryable(f: AttemptFailure): boolean {
  return (
    f.kind === "network" ||
    f.kind === "timeout" ||
    f.kind === "non_json_5xx" ||
    (f.kind === "json_error" && f.code === "cloud_runtime_unavailable")
  );
}

/**
 * A write that failed like this may have been applied. Any JSON 5xx counts, not only Bilinc's two
 * outcome-unknown codes: an edge or a later server code may answer after the write ran. The one
 * exception is `capability_unavailable`, which Bilinc sends before it reserves credits or runs anything.
 */
export function hasNoDefiniteAnswer(f: AttemptFailure): boolean {
  return (
    f.kind === "network" ||
    f.kind === "timeout" ||
    f.kind === "non_json_2xx" ||
    f.kind === "non_json_5xx" ||
    f.kind === "bad_shape" ||
    (f.kind === "json_error" && (UNKNOWN_OUTCOME_CODES.has(f.code) || (f.status >= 500 && f.code !== "capability_unavailable")))
  );
}

function cleanRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_RE.test(value) ? value : undefined;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whole seconds, at least 1: `Retry-After: 0` asks for no wait, so it is treated as absent. */
function retryAfterMs(response: Response): number | undefined {
  if (response.status !== 503) return undefined;
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw || !/^\d{1,7}$/.test(raw) || Number(raw) < 1) return undefined;
  return Math.min(Number(raw) * 1000, BREAKER_RETRY_AFTER_CAP_MS);
}

/** The exact Request the client sends. Exported for the Workers runtime test. */
export function buildRequest(baseUrl: string, apiKey: string, spec: RequestSpec, signal: AbortSignal): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (spec.method === "POST") headers["Content-Type"] = "application/json";
  if (spec.idempotencyKey) headers["Idempotency-Key"] = spec.idempotencyKey;
  return new Request(`${baseUrl}${API_PATH}${spec.path}`, {
    method: spec.method,
    headers,
    body: spec.method === "POST" ? JSON.stringify(spec.body ?? {}) : undefined,
    redirect: "manual",
    signal,
  });
}

/** One HTTP attempt. Never throws; never follows a redirect; the timeout covers the body read. */
export async function attempt(baseUrl: string, apiKey: string, spec: RequestSpec): Promise<AttemptResult> {
  const controller = new AbortController();
  let request: Request;
  try {
    request = buildRequest(baseUrl, apiKey, spec, controller.signal);
  } catch {
    return { ok: false, failure: { kind: "not_sent", code: "network", status: 0 } };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, spec.timeoutMs);

  try {
    let response: Response;
    try {
      response = await globalThis.fetch(request);
    } catch {
      return { ok: false, failure: { kind: timedOut ? "timeout" : "network", code: timedOut ? "timeout" : "network", status: 0 } };
    }

    const status = response.status;
    const headerRequestId = cleanRequestId(response.headers.get("X-Request-Id"));

    // Compared as a string: the Workers types (T7b) do not list "opaqueredirect" in Response["type"].
    if ((response.type as string) === "opaqueredirect" || (status >= 300 && status < 400)) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, failure: { kind: "redirect", code: "bad_response", status, requestId: headerRequestId } };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, failure: { kind: timedOut ? "timeout" : "network", code: timedOut ? "timeout" : "network", status: 0 } };
    }
    const body = parseObject(text);

    if (status >= 200 && status < 300) {
      if (!body) return { ok: false, failure: { kind: "non_json_2xx", code: "bad_response", status, requestId: headerRequestId } };
      const meta = body._meta;
      const metaId = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>).requestId : undefined;
      return { ok: true, status, body, requestId: cleanRequestId(metaId) ?? headerRequestId };
    }

    if (body && typeof body.error === "string" && CODE_RE.test(body.error)) {
      return {
        ok: false,
        failure: {
          kind: "json_error",
          code: body.error,
          status,
          requestId: cleanRequestId(body.requestId) ?? headerRequestId,
          details: body.details,
        },
      };
    }

    if (status >= 500) {
      const wait = retryAfterMs(response);
      return {
        ok: false,
        failure: { kind: "non_json_5xx", code: "bad_response", status, requestId: headerRequestId, ...(wait !== undefined ? { retryAfterMs: wait } : {}) },
      };
    }
    return { ok: false, failure: { kind: "non_json_4xx", code: "bad_response", status, requestId: headerRequestId } };
  } finally {
    clearTimeout(timer);
  }
}
