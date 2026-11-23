import { env, listDurableObjectIds } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionCookie } from "../src/gate";
import { handleRequest } from "../src/server";
import { installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { sessionCookie } from "./helpers/session";

const e = env as unknown as Env;

describe("Worker routing", () => {
  let bilinc: MockBilinc;
  let cookie: string;
  beforeEach(async () => {
    bilinc = installMockBilinc();
    cookie = await sessionCookie();
  });
  afterEach(() => bilinc.restore());

  const send = (path: string, init: RequestInit = {}, withEnv: Env = e) =>
    handleRequest(new Request(`https://agent.test${path}`, init), withEnv);

  it("answers 404 outside /api and /agents", async () => {
    expect((await send("/")).status).toBe(404);
    expect((await send("/index.html", { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it("answers 503 everywhere with a 15-character APP_ACCESS_TOKEN, even to the correct value", async () => {
    const short = { ...e, APP_ACCESS_TOKEN: "x".repeat(15) };
    const unlock = await send("/api/unlock", { method: "POST", body: JSON.stringify({ passphrase: "x".repeat(15) }) }, short);
    expect(unlock.status).toBe(503);
    expect(await unlock.json()).toEqual({ error: "access_token_too_short" });
    expect(unlock.headers.get("Set-Cookie")).toBeNull();
    const shortCookie = (await issueSessionCookie("x".repeat(15))).split(";")[0]!;
    for (const path of ["/api/health", `/agents/bilinc-agent/${crypto.randomUUID()}`]) {
      expect((await send(path, { headers: { Cookie: shortCookie } }, short)).status).toBe(503);
    }
    expect(bilinc.calls).toHaveLength(0);
  });

  it("unlocks with exactly 16 characters", async () => {
    const sixteen = { ...e, APP_ACCESS_TOKEN: "y".repeat(16) };
    const res = await send("/api/unlock", { method: "POST", body: JSON.stringify({ passphrase: "y".repeat(16) }) }, sixteen);
    expect(res.status).toBe(200);
  });

  it("answers 405 to other methods on /api/unlock", async () => {
    expect((await send("/api/unlock")).status).toBe(405);
  });

  it("answers 401 without a session on gated paths", async () => {
    for (const path of ["/api/health", "/api/other", `/agents/bilinc-agent/${crypto.randomUUID()}`]) {
      const res = await send(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(bilinc.calls).toHaveLength(0);
  });

  it("lets a fresh unlock cookie through to /api/health", async () => {
    const unlock = await send("/api/unlock", {
      method: "POST",
      headers: { "CF-Connecting-IP": crypto.randomUUID() },
      body: JSON.stringify({ passphrase: "correct-horse-battery-staple" }),
    });
    const fresh = unlock.headers.get("Set-Cookie")!.split(";")[0]!;
    expect((await send("/api/health", { headers: { Cookie: fresh } })).status).toBe(200);
  });

  it("answers 404 for unknown /api routes with a session", async () => {
    expect((await send("/api/other", { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it("refuses every /agents path but /agents/bilinc-agent/<uuid>, reaching no Durable Object", async () => {
    const limiterIdsBefore = (await listDurableObjectIds(e.UNLOCK_LIMITER)).length;
    const agentIdsBefore = (await listDurableObjectIds(e.BilincAgent)).length;
    for (const path of [
      "/agents/unlock-limiter/1.2.3.4",
      "/agents/bilinc-agent/default",
      "/agents/bilinc-agent/NOT-A-UUID",
      `/agents/bilinc-agent/${crypto.randomUUID().toUpperCase()}`,
      `/agents/other/${crypto.randomUUID()}`,
    ]) {
      const res = await send(path, { headers: { Cookie: cookie, Upgrade: "websocket" } });
      expect(res.status, path).toBe(404);
    }
    expect((await listDurableObjectIds(e.UNLOCK_LIMITER)).length).toBe(limiterIdsBefore);
    expect((await listDurableObjectIds(e.BilincAgent)).length).toBe(agentIdsBefore);
  });

  it("routes /agents/bilinc-agent/<uuid> to that chat's Durable Object", async () => {
    const chatId = crypto.randomUUID();
    const res = await send(`/agents/bilinc-agent/${chatId}`, { headers: { Cookie: cookie, Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
    const target = e.BilincAgent.idFromName(chatId);
    expect((await listDurableObjectIds(e.BilincAgent)).some((id) => id.equals(target))).toBe(true);
  });
});
