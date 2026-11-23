import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BilincError, NOTICES, defaultOnError, inputRejected, isBilincError, noticeFor } from "../src/errors";
import type { BilincOp } from "../src/errors";
import { KEY, makeClient, settle } from "./helpers/client";
import { apiError, hang, html, json, mockFetch, ok, redirect, reject } from "./helpers/mock-fetch";
import type { Responder } from "./helpers/mock-fetch";
import errorFixture from "./fixtures/error.json";

const err = (code: string, status: number, extra: Partial<ConstructorParameters<typeof BilincError>[0]> = {}) =>
  new BilincError({ code, status, ...extra });

describe("BilincError", () => {
  it("carries the spec fields with safe defaults", () => {
    const e = err("network", 0);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BilincError");
    expect(e.code).toBe("network");
    expect(e.status).toBe(0);
    expect(e.retryable).toBe(false);
    expect(e.outcomeUnknown).toBe(false);
    expect(e.requestId).toBeUndefined();
    expect(e.details).toBeUndefined();
    expect(e.message).toBe("Bilinc request failed: network");
  });

  it("isBilincError is a brand check, not instanceof", () => {
    const e = err("timeout", 0);
    const copy = Object.assign(Object.create(Error.prototype), e);
    Object.defineProperty(copy, Symbol.for("bilinc-cloudflare-agents/BilincError"), { value: true });
    expect(isBilincError(e)).toBe(true);
    expect(isBilincError(copy)).toBe(true);
    expect(isBilincError(new Error("x"))).toBe(false);
    expect(isBilincError({ code: "network", status: 0 })).toBe(false);
    expect(isBilincError(null)).toBe(false);
  });
});

describe("noticeFor: the messages table", () => {
  const rows: [string, BilincError, BilincOp, string][] = [
    ["missing_api_key", err("missing_api_key", 401), "list", NOTICES.keyInvalid],
    ["invalid_api_key", err("invalid_api_key", 401), "commit", NOTICES.keyInvalid],
    ["payment_required", err("payment_required", 402), "commit", NOTICES.creditsExhausted],
    ["capability_not_entitled", err("capability_not_entitled", 403), "diff", NOTICES.notOnPlan],
    ["entitlement_inactive", err("entitlement_inactive", 403), "history", NOTICES.notOnPlan],
    ["plan refusal on recall", err("capability_not_entitled", 403), "recall", NOTICES.notOnPlanRecall],
    ["invalid_request with field", err("invalid_request", 400, { details: { field: "label" } }), "createSnapshot", "input rejected: label"],
    ["invalid_request with field and reason", err("invalid_request", 400, { details: { field: "reason", reason: "reserved_reason" } }), "forget", "input rejected: reason (reserved_reason)"],
    ["invalid_request without details", err("invalid_request", 400), "list", NOTICES.inputRejectedByBilinc],
    ["invalid_request details without field", err("invalid_request", 400, { details: { reason: "response_too_large" } }), "history", NOTICES.inputRejectedByBilinc],
    ["invalid_request non-string field", err("invalid_request", 400, { details: { field: 42 } }), "list", NOTICES.inputRejectedByBilinc],
    ["invalid_request on snapshotId", err("invalid_request", 0, { details: { field: "snapshotId", reason: "pattern" } }), "rollbackPreview", NOTICES.checkpointNotFound],
    ["invalid_request on fromSnapshotId", err("invalid_request", 400, { details: { field: "fromSnapshotId" } }), "diff", NOTICES.checkpointNotFound],
    ["secret_detected", err("secret_detected", 422), "commit", NOTICES.secretDetected],
    ["memory_not_found", err("memory_not_found", 404), "history", NOTICES.notFound],
    ["snapshot_not_found", err("snapshot_not_found", 404), "diff", NOTICES.checkpointNotFound],
    ["version_conflict on commit", err("version_conflict", 409), "commit", NOTICES.commitRefused],
    ["version_conflict on snapshot", err("version_conflict", 409), "createSnapshot", NOTICES.requestConflict],
    ["version_conflict on rollback", err("version_conflict", 409), "rollback", NOTICES.requestConflict],
    ["idempotency_conflict without inFlight", err("idempotency_conflict", 409), "commit", NOTICES.requestConflict],
    ["idempotency_conflict with inFlight", err("idempotency_conflict", 409, { details: { inFlight: true } }), "commit", NOTICES.busy],
    ["memory_exists", err("memory_exists", 409), "commit", NOTICES.requestConflict],
    ["other 409", err("purge_blocked", 409), "forget", NOTICES.requestConflict],
    ["state_changed_since_preview", err("state_changed_since_preview", 409), "rollback", NOTICES.previewExpired],
    ["rollback_confirmation_expired", err("rollback_confirmation_expired", 410), "rollback", NOTICES.previewExpired],
    ["capability_unavailable", err("capability_unavailable", 503), "list", NOTICES.unavailable],
    ["JSON 429", err("rate_limited", 429), "recall", NOTICES.unavailable],
    ["other JSON 5xx", err("something_new", 500), "list", NOTICES.unavailable],
    ["network on a read", err("network", 0), "list", NOTICES.unavailable],
    ["timeout on a read", err("timeout", 0), "recall", NOTICES.unavailable],
    ["bad_response on a read", err("bad_response", 302), "history", NOTICES.unavailable],
    ["non-JSON 409 page", err("bad_response", 409), "commit", NOTICES.unavailable],
    ["circuit_open", err("circuit_open", 0), "commit", NOTICES.unavailable],
    ["rate_capped", err("rate_capped", 0), "commit", NOTICES.unavailable],
    ["write never answered", err("timeout", 0, { outcomeUnknown: true }), "commit", NOTICES.outcomeUnknown],
    ["outcomeUnknown wins over the code", err("mutation_outcome_unknown", 503, { outcomeUnknown: true }), "rollback", NOTICES.outcomeUnknown],
  ];

  it.each(rows)("%s", (_name, error, op, expected) => {
    expect(noticeFor(error, op)).toBe(expected);
  });

  it("version_conflict on forget depends on expectedVersion", () => {
    const e = err("version_conflict", 409);
    expect(noticeFor(e, "forget", { expectedVersion: true })).toBe(NOTICES.entryChanged);
    expect(noticeFor(e, "forget", { expectedVersion: false })).toBe(NOTICES.requestConflict);
    expect(noticeFor(e, "forget")).toBe(NOTICES.requestConflict);
  });

  it("anything that is not a BilincError is 'unavailable'", () => {
    expect(noticeFor(new TypeError("boom"), "list")).toBe(NOTICES.unavailable);
    expect(noticeFor("x", "commit")).toBe(NOTICES.unavailable);
  });

  it("never prints 'undefined'", () => {
    for (const details of [undefined, null, {}, { field: undefined }, { field: "x", reason: undefined }, { field: "x", reason: 7 }]) {
      expect(noticeFor(err("invalid_request", 400, { details }), "list")).not.toContain("undefined");
    }
  });

  it("pins the exact long strings", () => {
    expect(NOTICES.textTooLong).toBe(
      "not saved: text is longer than 2,000 characters; shorten it or split it into separate entries",
    );
    expect(NOTICES.noCheckpoints).toBe(
      "No checkpoints exist yet, so there is nothing to diff against or roll back to. Use bilinc_history to read earlier values of an entry, or bilinc_checkpoint to create a checkpoint now.",
    );
    expect(NOTICES.olderCheckpoints).toBe("older checkpoints may exist; call again with a larger limit (max 100)");
    expect(NOTICES.olderCheckpointsNotListed).toBe("older checkpoints may exist but are not listed: this list shows at most the newest 100");
    expect(inputRejected("label")).toBe("input rejected: label");
    expect(inputRejected("reason", "reserved_reason")).toBe("input rejected: reason (reserved_reason)");
  });
});

describe("defaultOnError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs op, code and requestId only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultOnError(err("payment_required", 402, { requestId: "req_abc123", details: { secret: "bil_live_x" } }), "commit");
    defaultOnError(err("network", 0), "list");
    expect(warn.mock.calls).toEqual([
      ["[bilinc] commit failed: payment_required requestId=req_abc123"],
      ["[bilinc] list failed: network"],
    ]);
  });
});

describe("client: read/write split", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const unknownOnWrite: [string, Responder][] = [
    ["cloud_runtime_unavailable", apiError(503, "cloud_runtime_unavailable")],
    ["rejected fetch", reject],
    ["timeout", hang],
    ["HTML 502", html(502)],
    ["HTML 504", html(504)],
    ["HTML 524", html(524)],
    ["maintenance 503", html(503, { "Retry-After": "300" })],
    ["JSON 500 with another code", apiError(500, "internal_error")],
  ];

  it.each(unknownOnWrite)("%s: outcome unknown on a write, unavailable on a read", async (_name, responder) => {
    mockFetch(responder);
    const { client } = makeClient();
    const write = settle(client.commit({ key: "k", value: "v" }));
    await vi.advanceTimersByTimeAsync(60_000);
    const w = await write;
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect((w.error as BilincError).outcomeUnknown).toBe(true);
    expect(noticeFor(w.error, "commit")).toBe(NOTICES.outcomeUnknown);

    const read = settle(makeClient().client.list());
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await read;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as BilincError).outcomeUnknown).toBe(false);
    expect(noticeFor(r.error, "list")).toBe(NOTICES.unavailable);
  });

  it("a 2xx that is not JSON is outcome unknown on a write", async () => {
    mockFetch(html(201));
    const w = await settle(makeClient().client.rollback({ snapshotId: "s1", reason: "r", confirmationToken: "t" }));
    expect(w.ok === false && noticeFor(w.error, "rollback")).toBe(NOTICES.outcomeUnknown);
  });

  it.each<[string, Responder]>([
    ["3xx", redirect(302)],
    ["non-JSON 4xx", html(403)],
  ])("%s: unavailable on both, never outcome unknown", async (_name, responder) => {
    mockFetch(responder);
    const w = await settle(makeClient().client.forget({ key: "k", reason: "r" }));
    const r = await settle(makeClient().client.history({ key: "k" }));
    for (const [result, op] of [[w, "forget"], [r, "history"]] as const) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect((result.error as BilincError).outcomeUnknown).toBe(false);
      expect(noticeFor(result.error, op)).toBe(NOTICES.unavailable);
    }
  });

  it("circuit_open and rate_capped send nothing and read 'unavailable'", async () => {
    const m = mockFetch(apiError(402, "payment_required"));
    const { client } = makeClient();
    await settle(client.commit({ key: "k", value: "v" }));
    const open = await settle(client.commit({ key: "k", value: "v" }));
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(open.ok === false && (open.error as BilincError).code).toBe("circuit_open");
    expect(open.ok === false && noticeFor(open.error, "commit")).toBe(NOTICES.unavailable);

    const m2 = mockFetch(ok({ results: [] }));
    const fresh = makeClient();
    for (let i = 0; i < 20; i++) await fresh.client.recall({ query: "q" });
    const capped = await settle(fresh.client.recall({ query: "q" }));
    expect(m2.fn).toHaveBeenCalledTimes(20);
    expect(capped.ok === false && (capped.error as BilincError)).toMatchObject({ code: "rate_capped", status: 0, outcomeUnknown: false });
    expect(capped.ok === false && noticeFor(capped.error, "recall")).toBe(NOTICES.unavailable);
  });
});

describe("client: version_conflict per operation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("commit: definite refusal, no second request, outcome known", async () => {
    const m = mockFetch(apiError(409, "version_conflict"));
    const r = await settle(makeClient().client.commit({ key: "k", value: "v" }));
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(r.ok === false && (r.error as BilincError).outcomeUnknown).toBe(false);
    expect(r.ok === false && noticeFor(r.error, "commit")).toBe(NOTICES.commitRefused);
  });

  it("forget with expectedVersion: the entry changed", async () => {
    mockFetch(apiError(409, "version_conflict"));
    const r = await settle(makeClient().client.forget({ key: "k", reason: "r", expectedVersion: "ev_1" }));
    expect(r.ok === false && noticeFor(r.error, "forget", { expectedVersion: true })).toBe(NOTICES.entryChanged);
  });

  it("invalid_request with no details from the server", async () => {
    mockFetch(apiError(400, "invalid_request"));
    const { client, onError } = makeClient();
    const r = await settle(client.list());
    expect(r.ok === false && noticeFor(r.error, "list")).toBe(NOTICES.inputRejectedByBilinc);
    expect(onError.mock.calls[0]?.[0].requestId).toBe("req_err");
  });
});

describe("client: fixture error body and key hygiene", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the error fixture maps to its field notice and keeps the requestId", async () => {
    mockFetch(json(400, errorFixture));
    const r = await settle(makeClient().client.createSnapshot({ label: "ok" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "invalid_request", status: 400, requestId: "req_fixture", outcomeUnknown: false });
    expect(noticeFor(r.error, "createSnapshot")).toBe("input rejected: label");
  });

  it("the key appears in no error, notice or default log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const responders: Responder[] = [apiError(401, "invalid_api_key"), reject, html(502), redirect(302)];
    for (const responder of responders) {
      mockFetch(responder);
      const { client } = makeClient();
      const r = await settle(client.forget({ key: "k", reason: "r" }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      const error = r.error as BilincError;
      defaultOnError(error, "forget");
      const surface = [error.message, String(error), JSON.stringify(error), JSON.stringify(error.details ?? null), noticeFor(error, "forget")];
      for (const text of surface) expect(text).not.toContain(KEY);
    }
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(KEY);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
