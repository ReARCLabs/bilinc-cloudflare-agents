import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkStatus, httpsBaseUrl } from "../src/health";
import { apiError, hang, html, json, mockFetch, ok, redirect, reject } from "./helpers/mock-fetch";
import type { Responder } from "./helpers/mock-fetch";
import statusFixture from "./fixtures/status.json";

const KEY = "bil_live_HEALTHKEY_never_print_me";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("checkStatus: decided without a request", () => {
  it.each(["", "bad.name", "x".repeat(65), "space here"])("namespace %j is namespace_invalid, even with no key", async (namespace) => {
    const m = mockFetch(ok({}));
    expect(await checkStatus({ apiKey: undefined, namespace })).toEqual({ state: "namespace_invalid" });
    expect(m.fn).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("key %j is key_missing", async (apiKey) => {
    const m = mockFetch(ok({}));
    expect(await checkStatus({ apiKey, namespace: "team_a" })).toEqual({ state: "key_missing" });
    expect(m.fn).not.toHaveBeenCalled();
  });

  it.each(["http://bilinc.space", "ftp://bilinc.space", "not a url", "https://user:pw@bilinc.space"])(
    "baseUrl %j is unreachable and the key is never sent",
    async (baseUrl) => {
      const m = mockFetch(ok({}));
      expect(await checkStatus({ apiKey: KEY, baseUrl })).toEqual({ state: "unreachable" });
      expect(m.fn).not.toHaveBeenCalled();
    },
  );
});

describe("checkStatus: one request", () => {
  it("a JSON success is ok, with the requestId", async () => {
    const m = mockFetch(json(200, statusFixture));
    const r = await checkStatus({ apiKey: KEY, namespace: "default" });
    expect(r).toEqual({ state: "ok", requestId: "req_status" });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({
      method: "GET",
      url: "https://bilinc.space/api/cloud/status",
      redirect: "manual",
      hasSignal: true,
      headers: { authorization: `Bearer ${KEY}`, accept: "application/json" },
    });
  });

  it.each<[string, Responder, string]>([
    ["missing_api_key", apiError(401, "missing_api_key"), "key_missing"],
    ["invalid_api_key", apiError(401, "invalid_api_key"), "key_invalid"],
    ["payment_required", apiError(402, "payment_required"), "unreachable"],
    ["cloud_runtime_unavailable", apiError(503, "cloud_runtime_unavailable"), "unreachable"],
    ["rejected fetch", reject, "unreachable"],
    ["3xx", redirect(302), "unreachable"],
    ["HTML 503", html(503, { "Retry-After": "300" }), "unreachable"],
  ])("%s gives %s after exactly one fetch", async (_name, responder, state) => {
    const m = mockFetch(responder);
    const r = await checkStatus({ apiKey: KEY });
    expect(r.state).toBe(state);
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("times out at 3 s with one fetch", async () => {
    const m = mockFetch(hang);
    const p = checkStatus({ apiKey: KEY });
    await vi.advanceTimersByTimeAsync(2999);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ state: "unreachable" });
    expect(m.fn).toHaveBeenCalledTimes(1);
  });

  it("honours timeoutMs", async () => {
    mockFetch(hang);
    const p = checkStatus({ apiKey: KEY, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toEqual({ state: "unreachable" });
  });

  it("never throws, even when fetch throws synchronously", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("sync boom");
    });
    await expect(checkStatus({ apiKey: KEY })).resolves.toEqual({ state: "unreachable" });
  });
});

describe("httpsBaseUrl", () => {
  it.each([
    [undefined, "https://bilinc.space"],
    ["https://bilinc.space/", "https://bilinc.space"],
    ["https://staging.bilinc.space/base/", "https://staging.bilinc.space/base"],
    ["http://bilinc.space", null],
    ["https://bilinc.space/?x=1", null],
    ["https://bilinc.space/#f", null],
  ])("%j → %j", (raw, expected) => {
    expect(httpsBaseUrl(raw)).toBe(expected);
  });
});
