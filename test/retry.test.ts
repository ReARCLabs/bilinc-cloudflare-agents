import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICES, noticeFor } from "../src/errors";
import { makeClient, settle } from "./helpers/client";
import { apiError, hang, html, mockFetch, ok, redirect, reject } from "./helpers/mock-fetch";
import type { Responder } from "./helpers/mock-fetch";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const LIST_OK = ok({ entries: [], total: 0, nextCursor: null });
const COMMIT_OK = ok({ affected_keys: ["k"], entryVersion: "ev_1" }, 201);

describe("free reads", () => {
  it("retry after 200 ms, then 600 ms, with no jitter", async () => {
    const m = mockFetch(reject, reject, LIST_OK);
    const p = settle(makeClient().client.list());
    await vi.advanceTimersByTimeAsync(0);
    expect(m.fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(m.fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(599);
    expect(m.fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.fn).toHaveBeenCalledTimes(3);
    expect((await p).ok).toBe(true);
  });

  it("stop after 3 attempts", async () => {
    const m = mockFetch(reject);
    const p = settle(makeClient().client.list());
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(m.fn).toHaveBeenCalledTimes(3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(noticeFor(r.error, "list")).toBe(NOTICES.unavailable);
  });

  it.each<[string, Responder]>([
    ["cloud_runtime_unavailable", apiError(503, "cloud_runtime_unavailable")],
    ["HTML 502", html(502)],
    ["rejected fetch", reject],
  ])("are retried after %s", async (_name, responder) => {
    const m = mockFetch(responder, LIST_OK);
    const p = settle(makeClient().client.list());
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).ok).toBe(true);
    expect(m.fn).toHaveBeenCalledTimes(2);
  });

  it("are not retried after a non-JSON 503 with Retry-After: the breaker opens for that time instead", async () => {
    const m = mockFetch(html(503, { "Retry-After": "300" }), LIST_OK);
    const { client } = makeClient();
    const p = settle(client.list());
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(noticeFor(r.error, "list")).toBe(NOTICES.unavailable);
    expect(m.fn).toHaveBeenCalledTimes(1);
    const next = settle(client.list());
    await vi.advanceTimersByTimeAsync(0);
    const n = await next;
    expect(n.ok).toBe(false);
    if (!n.ok) expect((n.error as { code: string }).code).toBe("circuit_open");
    expect(m.fn).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Responder]>([
    ["capability_unavailable", apiError(503, "capability_unavailable")],
    ["a JSON 4xx", apiError(404, "memory_not_found")],
    ["a JSON 429", apiError(429, "rate_limited")],
    ["a JSON 500 with another code", apiError(500, "brand_new_code")],
    ["a 3xx", redirect(301)],
    ["a non-JSON 4xx", html(403)],
    ["a non-JSON 2xx", html(200)],
  ])("are not retried after %s", async (_name, responder) => {
    const m = mockFetch(responder, LIST_OK);
    const p = settle(makeClient().client.history({ key: "k" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).ok).toBe(false);
    expect(m.fn).toHaveBeenCalledTimes(1);
  });

  it("time out after 3 s per attempt: worst case 3 attempts and 0.8 s of waiting", async () => {
    const m = mockFetch(hang);
    const p = settle(makeClient().client.list());
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(m.fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000 + 600);
    expect(m.fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2999);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.ok === false && (r.error as { code: string }).code).toBe("timeout");
  });
});

describe("recall", () => {
  it("is never retried", async () => {
    const m = mockFetch(reject, ok({ results: [] }));
    const p = settle(makeClient().client.recall({ query: "q" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).ok).toBe(false);
    expect(m.fn).toHaveBeenCalledTimes(1);
  });

  it("times out at 15 s", async () => {
    mockFetch(hang);
    const p = settle(makeClient().client.recall({ query: "q" }));
    await vi.advanceTimersByTimeAsync(14_999);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.ok === false && (r.error as { code: string; outcomeUnknown: boolean })).toMatchObject({ code: "timeout", outcomeUnknown: false });
  });
});

describe("writes", () => {
  it("time out at 20 s and are not retried: outcome unknown", async () => {
    const m = mockFetch(hang, COMMIT_OK);
    const p = settle(makeClient().client.commit({ key: "k", value: "v" }));
    await vi.advanceTimersByTimeAsync(19_999);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(r.ok === false && noticeFor(r.error, "commit")).toBe(NOTICES.outcomeUnknown);
  });

  it.each<[string, Responder]>([
    ["rejected fetch", reject],
    ["HTML 502", html(502)],
    ["cloud_runtime_unavailable", apiError(503, "cloud_runtime_unavailable")],
    ["mutation_outcome_unknown", apiError(503, "mutation_outcome_unknown")],
    ["a JSON 500 with another code (an edge or a later server code may answer after the write was applied)", apiError(500, "internal_error")],
    ["a JSON 504 with another code", apiError(504, "gateway_timeout")],
  ])("are not retried after %s", async (_name, responder) => {
    const m = mockFetch(responder, COMMIT_OK);
    const p = settle(makeClient().client.forget({ key: "k", reason: "r" }));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(r.ok === false && noticeFor(r.error, "forget")).toBe(NOTICES.outcomeUnknown);
  });

  it("repeat once, 500 ms later, with the same Idempotency-Key, on idempotency_conflict inFlight", async () => {
    const m = mockFetch(apiError(409, "idempotency_conflict", { operation: "memory.commit", inFlight: true }), COMMIT_OK);
    const p = settle(makeClient().client.commit({ key: "k", value: "v" }));
    await vi.advanceTimersByTimeAsync(499);
    expect(m.fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.fn).toHaveBeenCalledTimes(2);
    expect((await p).ok).toBe(true);
    expect(m.sent[1]?.headers["idempotency-key"]).toBe(m.sent[0]?.headers["idempotency-key"]);
    expect(m.sent[1]?.body).toEqual(m.sent[0]?.body);
  });

  it("still in flight after the one repeat: outcome unknown (the original may still complete), no third request", async () => {
    const m = mockFetch(apiError(409, "idempotency_conflict", { inFlight: true }));
    const p = settle(makeClient().client.createSnapshot({ label: "x" }));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(m.fn).toHaveBeenCalledTimes(2);
    expect(r.ok === false && (r.error as { code: string; outcomeUnknown: boolean; retryable: boolean })).toMatchObject({
      code: "idempotency_conflict",
      outcomeUnknown: true,
      retryable: false,
    });
    expect(r.ok === false && noticeFor(r.error, "createSnapshot")).toBe(NOTICES.outcomeUnknown);
  });

  it("capability_unavailable (refused before anything is reserved or run) is a definite answer", async () => {
    const m = mockFetch(apiError(503, "capability_unavailable"), COMMIT_OK);
    const p = settle(makeClient().client.commit({ key: "k", value: "v" }));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(r.ok === false && (r.error as { outcomeUnknown: boolean }).outcomeUnknown).toBe(false);
    expect(r.ok === false && noticeFor(r.error, "commit")).toBe(NOTICES.unavailable);
  });

  it("idempotency_conflict without inFlight is not repeated", async () => {
    const m = mockFetch(apiError(409, "idempotency_conflict"));
    const p = settle(makeClient().client.commit({ key: "k", value: "v" }));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(r.ok === false && noticeFor(r.error, "commit")).toBe(NOTICES.requestConflict);
  });
});
