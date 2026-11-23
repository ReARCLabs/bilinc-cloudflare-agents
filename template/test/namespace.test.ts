import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/server";
import { installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { scriptModel } from "./helpers/mock-model";
import { sessionCookie } from "./helpers/session";
import { setAgentEnv } from "./helpers/test-agent";
import { userMessage } from "./helpers/turns";

const e = env as unknown as Env;

async function saveFact(): Promise<void> {
  scriptModel([
    {
      toolCalls: [
        {
          toolName: "set_context",
          input: { label: "memory", content: "The user's favourite colour is green.", metadata: { title: "Favourite colour" } },
        },
      ],
    },
    { text: "saved" },
  ]);
  const stub = await getAgentByName(e.BilincAgent, crypto.randomUUID());
  await runInDurableObject(stub, (agent) => agent.saveMessages([userMessage("remember my favourite colour is green")]));
}

describe("namespace wiring", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
  });
  afterEach(() => {
    bilinc.restore();
    setAgentEnv(undefined);
  });

  it("uses cf.team_a. for commit and list with BILINC_NAMESPACE team_a", async () => {
    setAgentEnv({ BILINC_NAMESPACE: "team_a" });
    await saveFact();
    expect(bilinc.callsTo("POST", "/memory/commit").map((c) => c.body!.key)).toEqual(["cf.team_a.favourite-colour"]);
    const prefixes = bilinc.callsTo("POST", "/memory/list").map((c) => c.body!.prefix);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(new Set(prefixes)).toEqual(new Set(["cf.team_a."]));
  });

  it("falls back to cf.default. when the var is removed", async () => {
    setAgentEnv({ BILINC_NAMESPACE: undefined });
    await saveFact();
    expect(bilinc.callsTo("POST", "/memory/commit").map((c) => c.body!.key)).toEqual(["cf.default.favourite-colour"]);
  });

  it("sends the chat id as the commit sessionId", async () => {
    await saveFact();
    expect(String(bilinc.callsTo("POST", "/memory/commit")[0]!.body!.sessionId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("stops on an invalid namespace: health says so without calling Bilinc, configureContext throws", async () => {
    const res = await handleRequest(
      new Request("https://agent.test/api/health", { headers: { Cookie: await sessionCookie() } }),
      { ...e, BILINC_NAMESPACE: "bad.name" },
    );
    expect(await res.json()).toEqual({ state: "namespace_invalid" });
    expect(bilinc.calls).toHaveLength(0);

    setAgentEnv({ BILINC_NAMESPACE: "bad.name" });
    const stub = e.BilincAgent.get(e.BilincAgent.idFromName(crypto.randomUUID()));
    const message = await runInDurableObject(stub, (agent) => {
      try {
        agent.configureContext();
        return "did not throw";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(message).toBe("Bilinc namespace is invalid: use 1–64 letters, digits, `_` or `-`");
  });
});
