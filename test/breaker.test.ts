import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client";
import { Guard } from "../src/guard";
import { attempt, breakerEffect, hasNoDefiniteAnswer, isReadRetryable } from "../src/transport";
import type { BreakerEffect, FailureKind, RequestSpec } from "../src/transport";
import { makeClient, settle } from "./helpers/client";
import { apiError, hang, html, json, mockFetch, ok, redirect, reject } from "./helpers/mock-fetch";
import type { Responder } from "./helpers/mock-fetch";

const BASE = "https://bilinc.space";
const KEY = "bil_live_testkey";
const READ: RequestSpec = { method: "POST", path: "/memory/list", body: { limit: 1 }, timeoutMs: 3000 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const COUNT: BreakerEffect = { kind: "count" };
const RESET: BreakerEffect = { kind: "reset" };

describe("Guard: breaker", () => {
  it.each([
    ["payment_required-like open", 60_000],
    ["Retry-After 300", 300_000],
    ["Retry-After capped", 600_000],
  ])("opens at once (%s) with the count at 0", (_name, openMs) => {
    const g = new Guard();
    g.record({ kind: "open", openMs });
    expect(g.admit(false)).toBe("circuit_open");
    vi.advanceTimersByTime(openMs - 1);
    expect(g.admit(false)).toBe("circuit_open");
    vi.advanceTimersByTime(1);
    expect(g.admit(false)).toBeNull();
  });

  it("three counted failures open it for 60 s; two do not", () => {
    const g = new Guard();
    g.record(COUNT);
    g.record(COUNT);
    expect(g.admit(false)).toBeNull();
    g.record(COUNT);
    expect(g.admit(false)).toBe("circuit_open");
    vi.advanceTimersByTime(60_000);
    expect(g.admit(false)).toBeNull();
  });

  it("a reset between failures keeps it closed", () => {
    const g = new Guard();
    g.record(COUNT);
    g.record(COUNT);
    g.record(RESET);
    g.record(COUNT);
    g.record(COUNT);
    expect(g.admit(false)).toBeNull();
    expect(g.state().failures).toBe(2);
  });

  it("'none' neither raises nor resets the count", () => {
    const g = new Guard();
    g.record(COUNT);
    g.record({ kind: "none" });
    expect(g.state().failures).toBe(1);
    g.record(COUNT);
    g.record({ kind: "none" });
    g.record(COUNT);
    expect(g.admit(false)).toBe("circuit_open");
  });

  it("calls while open do not extend the open time", () => {
    const g = new Guard();
    g.record({ kind: "open", openMs: 60_000 });
    vi.advanceTimersByTime(30_000);
    expect(g.admit(true)).toBe("circuit_open");
    g.record({ kind: "none" });
    g.record(COUNT);
    vi.advanceTimersByTime(30_000);
    expect(g.admit(false)).toBeNull();
  });

  it("after the open time the count is 0 and two failures do not reopen it", () => {
    const g = new Guard();
    g.record({ kind: "open", openMs: 60_000 });
    vi.advanceTimersByTime(60_000);
    expect(g.admit(false)).toBeNull();
    expect(g.state().failures).toBe(0);
    g.record(COUNT);
    g.record(COUNT);
    expect(g.admit(false)).toBeNull();
  });
});

describe("Guard: rate cap", () => {
  it("the 21st billable call inside 60 s is rate_capped; free calls are not counted", () => {
    const g = new Guard();
    for (let i = 0; i < 20; i++) expect(g.admit(true)).toBeNull();
    for (let i = 0; i < 30; i++) expect(g.admit(false)).toBeNull();
    expect(g.admit(true)).toBe("rate_capped");
  });

  it("the window slides", () => {
    const g = new Guard();
    for (let i = 0; i < 20; i++) g.admit(true);
    vi.advanceTimersByTime(59_999);
    expect(g.admit(true)).toBe("rate_capped");
    vi.advanceTimersByTime(1);
    expect(g.admit(true)).toBeNull();
  });

  it("a capped call does not touch the breaker", () => {
    const g = new Guard();
    for (let i = 0; i < 20; i++) g.admit(true);
    g.record(COUNT);
    expect(g.admit(true)).toBe("rate_capped");
    expect(g.state().failures).toBe(1);
  });
});

describe("attempt: request init", () => {
  it("sends the headers, redirect manual and a signal", async () => {
    const m = mockFetch(ok({ entries: [] }));
    await attempt(BASE, KEY, { ...READ, idempotencyKey: "idem-1" });
    expect(m.sent[0]).toMatchObject({
      method: "POST",
      url: "https://bilinc.space/api/cloud/memory/list",
      redirect: "manual",
      hasSignal: true,
      body: { limit: 1 },
      headers: {
        authorization: `Bearer ${KEY}`,
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": "idem-1",
      },
    });
  });

  it("GET has no body and no Content-Type", async () => {
    const m = mockFetch(ok({ snapshots: [] }));
    await attempt(BASE, KEY, { method: "GET", path: "/memory/snapshots?limit=20", timeoutMs: 3000 });
    expect(m.sent[0]?.headers["content-type"]).toBeUndefined();
    expect(m.sent[0]?.body).toBeUndefined();
    expect(m.sent[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("a Request construction error is never sent", async () => {
    const m = mockFetch(ok({}));
    const r = await attempt(BASE, "bil_live\nbroken", READ);
    expect(m.fn).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: false, failure: { kind: "not_sent", code: "network", status: 0 } });
  });

  it("a JSON success returns the body and the requestId", async () => {
    mockFetch(ok({ total: 2 }));
    const r = await attempt(BASE, KEY, READ);
    expect(r).toMatchObject({ ok: true, status: 200, body: { total: 2 }, requestId: "req_ok" });
  });
});

type Row = [string, Responder, FailureKind, string, BreakerEffect, boolean, boolean];

describe("attempt: classification", () => {
  const rows: Row[] = [
    // name, responder, kind, code, breaker, read-retryable, no definite answer
    ["rejected fetch", reject, "network", "network", COUNT, true, true],
    ["302", redirect(302), "redirect", "bad_response", COUNT, false, false],
    ["307", redirect(307), "redirect", "bad_response", COUNT, false, false],
    ["HTML 502", html(502), "non_json_5xx", "bad_response", COUNT, true, true],
    ["HTML 504", html(504), "non_json_5xx", "bad_response", COUNT, true, true],
    ["HTML 524", html(524), "non_json_5xx", "bad_response", COUNT, true, true],
    ["HTML 503 Retry-After 300", html(503, { "Retry-After": "300" }), "non_json_5xx", "bad_response", { kind: "open", openMs: 300_000 }, true, true],
    ["HTML 503 Retry-After 900", html(503, { "Retry-After": "900" }), "non_json_5xx", "bad_response", { kind: "open", openMs: 600_000 }, true, true],
    ["HTML 503 without Retry-After", html(503), "non_json_5xx", "bad_response", COUNT, true, true],
    ["HTML 403", html(403), "non_json_4xx", "bad_response", COUNT, false, false],
    ["200 not JSON", html(200), "non_json_2xx", "bad_response", COUNT, false, true],
    ["200 JSON array", json(200, [1, 2]), "non_json_2xx", "bad_response", COUNT, false, true],
    ["JSON 500 without error string", json(500, { oops: true }), "non_json_5xx", "bad_response", COUNT, true, true],
    ["payment_required", apiError(402, "payment_required"), "json_error", "payment_required", { kind: "open", openMs: 60_000 }, false, false],
    ["missing_api_key", apiError(401, "missing_api_key"), "json_error", "missing_api_key", { kind: "open", openMs: 60_000 }, false, false],
    ["invalid_api_key", apiError(401, "invalid_api_key"), "json_error", "invalid_api_key", { kind: "open", openMs: 60_000 }, false, false],
    ["cloud_runtime_unavailable", apiError(503, "cloud_runtime_unavailable"), "json_error", "cloud_runtime_unavailable", COUNT, true, true],
    ["mutation_outcome_unknown", apiError(503, "mutation_outcome_unknown"), "json_error", "mutation_outcome_unknown", COUNT, false, true],
    ["JSON 500 unknown code", apiError(500, "brand_new_code"), "json_error", "brand_new_code", COUNT, false, true],
    ["JSON 502 internal_error", apiError(502, "internal_error"), "json_error", "internal_error", COUNT, false, true],
    ["JSON 429", apiError(429, "rate_limited"), "json_error", "rate_limited", COUNT, false, false],
    ["capability_unavailable", apiError(503, "capability_unavailable"), "json_error", "capability_unavailable", RESET, false, false],
    ["memory_not_found", apiError(404, "memory_not_found"), "json_error", "memory_not_found", RESET, false, false],
    ["snapshot_not_found", apiError(404, "snapshot_not_found"), "json_error", "snapshot_not_found", RESET, false, false],
    ["invalid_request", apiError(400, "invalid_request", { field: "label" }), "json_error", "invalid_request", RESET, false, false],
    ["secret_detected", apiError(422, "secret_detected"), "json_error", "secret_detected", RESET, false, false],
    ["version_conflict", apiError(409, "version_conflict"), "json_error", "version_conflict", RESET, false, false],
    ["capability_not_entitled", apiError(403, "capability_not_entitled"), "json_error", "capability_not_entitled", RESET, false, false],
    ["entitlement_inactive", apiError(403, "entitlement_inactive"), "json_error", "entitlement_inactive", RESET, false, false],
    ["idempotency_conflict", apiError(409, "idempotency_conflict"), "json_error", "idempotency_conflict", RESET, false, false],
    ["memory_exists", apiError(409, "memory_exists"), "json_error", "memory_exists", RESET, false, false],
    ["state_changed_since_preview", apiError(409, "state_changed_since_preview"), "json_error", "state_changed_since_preview", RESET, false, false],
    ["rollback_confirmation_expired", apiError(410, "rollback_confirmation_expired"), "json_error", "rollback_confirmation_expired", RESET, false, false],
  ];

  it.each(rows)("%s", async (_name, responder, kind, code, effect, retryable, unknown) => {
    mockFetch(responder);
    const r = await attempt(BASE, KEY, READ);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe(kind);
    expect(r.failure.code).toBe(code);
    expect(breakerEffect(r.failure)).toEqual(effect);
    expect(isReadRetryable(r.failure)).toBe(retryable);
    expect(hasNoDefiniteAnswer(r.failure)).toBe(unknown);
  });

  it("a JSON error keeps requestId and details", async () => {
    mockFetch(apiError(409, "idempotency_conflict", { inFlight: true }));
    const r = await attempt(BASE, KEY, READ);
    expect(r).toEqual({
      ok: false,
      failure: { kind: "json_error", code: "idempotency_conflict", status: 409, requestId: "req_err", details: { inFlight: true } },
    });
  });

  it("times out at timeoutMs and sends once", async () => {
    const m = mockFetch(hang);
    const p = attempt(BASE, KEY, READ);
    await vi.advanceTimersByTimeAsync(2999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r).toEqual({ ok: false, failure: { kind: "timeout", code: "timeout", status: 0 } });
    expect(m.fn).toHaveBeenCalledTimes(1);
  });

  it("the timeout also covers a body that never finishes", async () => {
    mockFetch(
      (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
            },
          }),
          { status: 200 },
        ),
    );
    const p = attempt(BASE, KEY, READ);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toEqual({ ok: false, failure: { kind: "timeout", code: "timeout", status: 0 } });
  });

  it("an error code that is not a plain code string is treated as non-JSON", async () => {
    mockFetch(json(400, { error: "<script>alert(1)</script>" }));
    const r = await attempt(BASE, KEY, READ);
    expect(r.ok === false && r.failure.kind).toBe("non_json_4xx");
  });
});

describe("client: breaker judged once per logical call", () => {
  const LIST_OK = ok({ entries: [], total: 0, nextCursor: null });

  it("a read that fails on all three attempts adds one, not three", async () => {
    const m = mockFetch(reject);
    const { client, guard } = makeClient();
    const p = settle(client.list());
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(m.fn).toHaveBeenCalledTimes(3);
    expect(guard.state()).toMatchObject({ failures: 1, open: false });
  });

  it.each<[string, Responder]>([
    ["payment_required", apiError(402, "payment_required")],
    ["missing_api_key", apiError(401, "missing_api_key")],
    ["invalid_api_key", apiError(401, "invalid_api_key")],
  ])("%s on one call opens it for 60 s; nothing is sent while open", async (_name, responder) => {
    const m = mockFetch(responder, LIST_OK);
    const { client } = makeClient();
    await settle(client.commit({ key: "k", value: "v" }));
    const blocked = await settle(client.list());
    expect(blocked.ok === false && (blocked.error as { code: string }).code).toBe("circuit_open");
    expect(m.fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect((await settle(client.list())).ok).toBe(true);
    expect(m.fn).toHaveBeenCalledTimes(2);
  });

  it.each<[string, Responder]>([
    ["network", reject],
    ["3xx", redirect(302)],
    ["HTML 502", html(502)],
    ["2xx not JSON", html(200)],
    ["cloud_runtime_unavailable", apiError(503, "cloud_runtime_unavailable")],
    ["mutation_outcome_unknown", apiError(503, "mutation_outcome_unknown")],
    ["JSON 500 unknown code", apiError(500, "brand_new_code")],
    ["JSON 429", apiError(429, "rate_limited")],
  ])("%s: two writes in a row keep it closed, three open it", async (_name, responder) => {
    const m = mockFetch(responder);
    const { client } = makeClient();
    await settle(client.forget({ key: "k", reason: "r" }));
    await settle(client.forget({ key: "k", reason: "r" }));
    const third = settle(client.forget({ key: "k", reason: "r" }));
    expect(m.fn).toHaveBeenCalledTimes(3);
    await third;
    const fourth = await settle(client.forget({ key: "k", reason: "r" }));
    expect(fourth.ok === false && (fourth.error as { code: string }).code).toBe("circuit_open");
    expect(m.fn).toHaveBeenCalledTimes(3);
  });

  it("timeout counts as one failure", async () => {
    mockFetch(hang);
    const { client, guard } = makeClient();
    const p = settle(client.recall({ query: "q" }));
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    expect(guard.state().failures).toBe(1);
  });

  it.each<[string, Responder]>([
    ["a JSON success", LIST_OK],
    ["memory_not_found", apiError(404, "memory_not_found")],
    ["snapshot_not_found", apiError(404, "snapshot_not_found")],
    ["invalid_request", apiError(400, "invalid_request")],
    ["secret_detected", apiError(422, "secret_detected")],
    ["version_conflict", apiError(409, "version_conflict")],
    ["capability_not_entitled", apiError(403, "capability_not_entitled")],
    ["entitlement_inactive", apiError(403, "entitlement_inactive")],
    ["idempotency_conflict without inFlight", apiError(409, "idempotency_conflict")],
    ["memory_exists", apiError(409, "memory_exists")],
    ["state_changed_since_preview", apiError(409, "state_changed_since_preview")],
    ["rollback_confirmation_expired", apiError(410, "rollback_confirmation_expired")],
    ["capability_unavailable", apiError(503, "capability_unavailable")],
  ])("%s resets the count: fail, fail, this, fail, fail stays closed", async (_name, responder) => {
    const m = mockFetch(redirect(), redirect(), responder, redirect(), redirect(), LIST_OK);
    const { client } = makeClient();
    for (let i = 0; i < 5; i++) await settle(client.list());
    expect((await settle(client.list())).ok).toBe(true);
    expect(m.fn).toHaveBeenCalledTimes(6);
  });

  it("three unknown keys in history leave it closed and the next list is sent", async () => {
    const m = mockFetch(apiError(404, "memory_not_found"), apiError(404, "memory_not_found"), apiError(404, "memory_not_found"), LIST_OK);
    const { client } = makeClient();
    for (const key of ["a", "b", "c"]) await settle(client.history({ key }));
    expect((await settle(client.list())).ok).toBe(true);
    expect(m.fn).toHaveBeenCalledTimes(4);
  });

  it("a list that always answers capability_unavailable never opens it; a commit is still sent", async () => {
    const m = mockFetch(
      apiError(503, "capability_unavailable"),
      apiError(503, "capability_unavailable"),
      apiError(503, "capability_unavailable"),
      apiError(503, "capability_unavailable"),
      ok({ affected_keys: ["k"], entryVersion: "ev" }, 201),
    );
    const { client } = makeClient();
    for (let i = 0; i < 4; i++) await settle(client.list({ order: "newest" }));
    expect((await settle(client.commit({ key: "k", value: "v" }))).ok).toBe(true);
    expect(m.fn).toHaveBeenCalledTimes(5);
  });

  it("validation failures, Request construction errors and rate_capped have no effect", async () => {
    mockFetch(redirect());
    const shared = new Guard();
    const { client } = makeClient(shared);
    await settle(client.list());
    await settle(client.forget({ key: "k", reason: "" }));
    const broken = createClient({ apiKey: "bad\nkey", baseUrl: "https://bilinc.space", guard: shared, onError: () => {} });
    await settle(broken.list());
    expect(shared.state().failures).toBe(1);
    await settle(client.list());
    expect(shared.state().failures).toBe(2);
  });

  it("two clients on one guard share it; two guards do not", async () => {
    mockFetch(apiError(402, "payment_required"), LIST_OK);
    const guard = new Guard();
    const a = makeClient(guard);
    const b = makeClient(guard);
    const other = makeClient();
    await settle(a.client.commit({ key: "k", value: "v" }));
    const viaB = await settle(b.client.list());
    expect(viaB.ok === false && (viaB.error as { code: string }).code).toBe("circuit_open");
    expect((await settle(other.client.list())).ok).toBe(true);
  });

  it("the cap counts billable calls only, per guard", async () => {
    const m = mockFetch(ok({ results: [], snapshots: [], entries: [], total: 0 }));
    const { client } = makeClient();
    for (let i = 0; i < 20; i++) await client.recall({ query: "q" });
    for (let i = 0; i < 15; i++) await client.list();
    for (let i = 0; i < 15; i++) await client.listSnapshots();
    const capped = await settle(client.recall({ query: "q" }));
    expect(capped.ok === false && (capped.error as { code: string }).code).toBe("rate_capped");
    expect(m.fn).toHaveBeenCalledTimes(50);
  });
});
