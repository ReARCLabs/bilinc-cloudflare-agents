import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointsBody } from "../src/checkpoints";
import { handleRequest } from "../src/server";
import { htmlPage, installMockBilinc, TEST_API_KEY, type MockBilinc } from "./helpers/mock-bilinc";
import { sessionCookie } from "./helpers/session";

const e = env as unknown as Env;

async function checkpoints(withEnv: Partial<Env> = {}, cookie = true): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = cookie ? { Cookie: await sessionCookie() } : {};
  const res = await handleRequest(new Request("https://agent.test/api/checkpoints", { headers }), { ...e, ...withEnv } as Env);
  return { status: res.status, body: await res.json() };
}

/** Writes through the mock's own API, as the agent's tools would. */
async function seed(method: string, path: string, body: unknown): Promise<void> {
  await fetch(`https://bilinc.space/api/cloud${path}`, {
    method,
    headers: { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/checkpoints", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
  });
  afterEach(() => {
    bilinc.restore();
    vi.restoreAllMocks();
  });

  it("answers 401 without the session cookie and calls nothing", async () => {
    expect(await checkpoints({}, false)).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(bilinc.calls).toHaveLength(0);
  });

  it("lists the checkpoints newest first with the project total, using free reads only", async () => {
    await seed("POST", "/memory/commit", { key: "cf.default.favourite-tea", value: "Rooibos" });
    await seed("POST", "/memory/snapshots", { label: "Before tea change" });
    await seed("POST", "/memory/commit", { key: "cf.default.morning", value: "Run" });
    await seed("POST", "/memory/snapshots", {});
    bilinc.calls.splice(0);

    const { status, body } = await checkpoints();
    expect(status).toBe(200);
    const b = body as CheckpointsBody;
    expect(b.state).toBe("ok");
    expect(b.now).toEqual({ total: 2 });
    expect(b.checkpoints.map((c) => [c.id, c.label, c.totalEntries])).toEqual([
      ["snap_2", null, 2],
      ["snap_1", "Before tea change", 1],
    ]);
    expect(Object.keys(b.checkpoints[0]!).sort()).toEqual(["createdAt", "id", "label", "totalEntries"]);
    expect(bilinc.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /memory/snapshots", "POST /memory/list"]);
  });

  it("is key_missing with no request when the key is empty", async () => {
    expect(await checkpoints({ BILINC_API_KEY: "" })).toEqual({ status: 200, body: { state: "key_missing", checkpoints: [], now: null } });
    expect(bilinc.calls).toHaveLength(0);
  });

  it("is key_invalid when Bilinc rejects the key", async () => {
    expect((await checkpoints({ BILINC_API_KEY: "bil_live_revoked" })).body).toEqual({ state: "key_invalid", checkpoints: [], now: null });
  });

  it("is namespace_invalid with no request", async () => {
    expect((await checkpoints({ BILINC_NAMESPACE: "bad.name" })).body).toEqual({ state: "namespace_invalid", checkpoints: [], now: null });
    expect(bilinc.calls).toHaveLength(0);
  });

  it("is unreachable on an edge page", async () => {
    bilinc.override("GET /memory/snapshots", () => htmlPage(503));
    expect((await checkpoints()).body).toEqual({ state: "unreachable", checkpoints: [], now: null });
  });

  it("keeps the checkpoints when only the count read fails, with now: null", async () => {
    await seed("POST", "/memory/snapshots", { label: "Before tea change" });
    bilinc.override("POST /memory/list", () => htmlPage(503));
    const b = (await checkpoints()).body as CheckpointsBody;
    expect(b.state).toBe("ok");
    expect(b.now).toBeNull();
    expect(b.checkpoints.map((c) => c.id)).toEqual(["snap_1"]);
  });

  it("reads Bilinc afresh on every call, with no cached answer", async () => {
    const pair = ["GET /memory/snapshots", "POST /memory/list"];
    expect(((await checkpoints()).body as CheckpointsBody).checkpoints).toEqual([]);
    await seed("POST", "/memory/snapshots", { label: "Just made" });
    bilinc.calls.splice(0);
    const b = (await checkpoints()).body as CheckpointsBody;
    expect(b.checkpoints.map((c) => c.label)).toEqual(["Just made"]);
    expect(bilinc.calls.map((c) => `${c.method} ${c.path}`)).toEqual(pair);
  });

  it("answers each key on its own", async () => {
    await checkpoints();
    expect((await checkpoints({ BILINC_API_KEY: "bil_live_revoked" })).body).toEqual({ state: "key_invalid", checkpoints: [], now: null });
    expect(((await checkpoints()).body as CheckpointsBody).state).toBe("ok");
  });
});
