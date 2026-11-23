import { describe, expect, it } from "vitest";
import { checkStatus } from "../../src/health";
import { attempt, buildRequest } from "../../src/transport";
import type { RequestSpec } from "../../src/transport";

const BASE = "https://bilinc.space";
const KEY = "bil_live_WORKERDKEY_never_print_me";

interface Echo {
  echo: { method: string; path: string; headers: Record<string, string>; body: string };
}

describe("fetch init in workerd", () => {
  it("accepts the client's exact POST init: headers, JSON body, redirect manual and a signal", async () => {
    const spec: RequestSpec = {
      method: "POST",
      path: "/memory/commit",
      body: { key: "cf.default.k", value: "v" },
      idempotencyKey: "idem-1",
      timeoutMs: 3000,
    };
    const request = buildRequest(BASE, KEY, spec, new AbortController().signal);
    expect(request.redirect).toBe("manual");
    const response = await fetch(request);
    expect(response.status).toBe(200);
    const { echo } = (await response.json()) as Echo;
    expect(echo.method).toBe("POST");
    expect(echo.path).toBe("/api/cloud/memory/commit");
    expect(echo.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": "idem-1",
    });
    expect(JSON.parse(echo.body)).toEqual({ key: "cf.default.k", value: "v" });
  });

  it("accepts the client's exact GET init, without a body", async () => {
    const request = buildRequest(BASE, KEY, { method: "GET", path: "/memory/snapshots?limit=20", timeoutMs: 3000 }, new AbortController().signal);
    const { echo } = (await (await fetch(request)).json()) as Echo;
    expect(echo.method).toBe("GET");
    expect(echo.path).toBe("/api/cloud/memory/snapshots?limit=20");
    expect(echo.headers["content-type"]).toBeUndefined();
    expect(echo.body).toBe("");
  });

  it("does not follow a redirect: attempt() reports it as bad_response", async () => {
    const result = await attempt(BASE, KEY, { method: "GET", path: "/redirect", timeoutMs: 3000 });
    expect(result).toMatchObject({ ok: false, failure: { kind: "redirect", code: "bad_response" } });
  });

  it("rejects the fetch when the request's signal is aborted", async () => {
    const controller = new AbortController();
    const request = buildRequest(BASE, KEY, { method: "GET", path: "/status", timeoutMs: 3000 }, controller.signal);
    controller.abort();
    await expect(fetch(request)).rejects.toThrow();
  });

  it("checkStatus() makes its request in workerd and reads the answer", async () => {
    expect(await checkStatus({ apiKey: KEY, namespace: "default" })).toEqual({ state: "ok", requestId: "req_workerd" });
  });

  it("checkStatus() decides without a request when the key is missing or the namespace is invalid", async () => {
    expect(await checkStatus({ apiKey: undefined })).toEqual({ state: "key_missing" });
    expect(await checkStatus({ apiKey: KEY, namespace: "bad.name" })).toEqual({ state: "namespace_invalid" });
  });
});
