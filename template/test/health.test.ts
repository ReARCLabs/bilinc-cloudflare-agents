import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/server";
import { bilincError, deferredResponse, htmlPage, installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { sessionCookie } from "./helpers/session";

const e = env as unknown as Env;

describe("GET /api/health", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
  });
  afterEach(() => bilinc.restore());

  async function health(withEnv: Partial<Env> = {}): Promise<{ status: number; body: unknown }> {
    const res = await handleRequest(
      new Request("https://agent.test/api/health", { headers: { Cookie: await sessionCookie() } }),
      { ...e, ...withEnv } as Env,
    );
    return { status: res.status, body: await res.json() };
  }

  it("ok", async () => {
    expect(await health()).toEqual({ status: 200, body: { state: "ok" } });
    expect(bilinc.callsTo("GET", "/status")).toHaveLength(1);
  });

  it("key_missing without a request when the secret is empty", async () => {
    expect(await health({ BILINC_API_KEY: "" })).toEqual({ status: 200, body: { state: "key_missing" } });
    expect(bilinc.calls).toHaveLength(0);
  });

  it("key_invalid when Bilinc rejects the key", async () => {
    expect(await health({ BILINC_API_KEY: "bil_live_revoked" })).toEqual({ status: 200, body: { state: "key_invalid" } });
    expect(bilinc.calls).toHaveLength(1);
  });

  it("namespace_invalid without a request", async () => {
    expect(await health({ BILINC_NAMESPACE: "bad.name" })).toEqual({ status: 200, body: { state: "namespace_invalid" } });
    expect(bilinc.calls).toHaveLength(0);
  });

  it("unreachable on an edge page or a JSON 5xx, with exactly one request each", async () => {
    bilinc.override("GET /status", () => htmlPage(503, { "Retry-After": "300" }));
    expect((await health()).body).toEqual({ state: "unreachable" });
    bilinc.override("GET /status", () => bilincError(503, "cloud_runtime_unavailable"));
    expect((await health()).body).toEqual({ state: "unreachable" });
    expect(bilinc.callsTo("GET", "/status")).toHaveLength(2);
  });

  it("answers within the 3 s timeout when Bilinc never answers", async () => {
    const never = deferredResponse();
    bilinc.override("GET /status", never.handler);
    const started = Date.now();
    expect((await health()).body).toEqual({ state: "unreachable" });
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(bilinc.callsTo("GET", "/status")).toHaveLength(1);
    never.release();
  });
});
