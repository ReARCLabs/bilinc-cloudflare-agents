// MODELS allowlist and the per-chat model choice: pure rules first, then the agent over the chat
// WebSocket exactly as useAgentChat sends a request (custom body fields next to messages).
import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEffort, parseModels, resolveChoice, type ModelsConfig } from "../src/models";
import { handleRequest } from "../src/server";
import { installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { scriptModel } from "./helpers/mock-model";
import { sessionCookie } from "./helpers/session";
import { recordedChoices, setAgentEnv } from "./helpers/test-agent";
import { userMessage, waitFor } from "./helpers/turns";

const e = env as unknown as Env;
const BIG = "@cf/openai/gpt-oss-120b";
const SMALL = "@cf/openai/gpt-oss-20b";
const NO_EFFORT = "@cf/example/no-reasoning-model";
const ALL = ["low", "medium", "high"];

describe("parseModels", () => {
  it("reads an array and a JSON string the same way", () => {
    const list = [
      { id: BIG, label: "gpt-oss-120b", note: "Default", tag: "tested", effort: ALL },
      { id: NO_EFFORT, effort: null },
    ];
    const fromArray = parseModels(list, BIG);
    expect(parseModels(JSON.stringify(list), BIG)).toEqual(fromArray);
    expect(fromArray).toEqual({
      defaultId: BIG,
      models: [
        { id: BIG, label: "gpt-oss-120b", note: "Default", tag: "tested", effort: ["low", "medium", "high"] },
        { id: NO_EFFORT, label: "no-reasoning-model", note: "", tag: "", effort: null },
      ],
    });
  });

  it("drops entries without a @cf id, repeated ids and unknown effort levels", () => {
    const config = parseModels(
      [{ id: "openai/gpt-5.5" }, { id: "@cf/x" }, { id: 7 }, null, { id: BIG, effort: ["high", "turbo", "low"] }, { id: BIG, label: "again" }],
      BIG,
    );
    expect(config.models).toEqual([{ id: BIG, label: "gpt-oss-120b", note: "", tag: "", effort: ["low", "high"] }]);
  });

  it("always includes MODEL, first when MODELS lacks it, and survives a broken var", () => {
    expect(parseModels("not json", BIG)).toEqual({ defaultId: BIG, models: [{ id: BIG, label: "gpt-oss-120b", note: "", tag: "", effort: null }] });
    expect(parseModels([{ id: NO_EFFORT }], BIG).models.map((m) => m.id)).toEqual([BIG, NO_EFFORT]);
  });
});

describe("resolveChoice", () => {
  const config: ModelsConfig = parseModels([{ id: BIG, effort: ALL }, { id: SMALL, effort: ["low", "high"] }, { id: NO_EFFORT, effort: null }], BIG);

  it("defaults to MODEL with medium effort, or the first level when medium is not listed", () => {
    expect(resolveChoice(undefined, config, undefined)).toEqual({ model: BIG, effort: "medium" });
    expect(defaultEffort(config.models[1]!)).toBe("low");
  });

  it("takes a listed model and effort from the request", () => {
    expect(resolveChoice({ model: SMALL, effort: "high" }, config, undefined)).toEqual({ model: SMALL, effort: "high" });
  });

  it("falls back to MODEL for an unlisted model, and to the default effort for an unlisted effort", () => {
    expect(resolveChoice({ model: "@cf/evil/model", effort: "high" }, config, { model: SMALL, effort: "low" })).toEqual({ model: BIG, effort: "high" });
    expect(resolveChoice({ model: SMALL, effort: "medium" }, config, undefined)).toEqual({ model: SMALL, effort: "low" });
    expect(resolveChoice({ model: BIG, effort: { $gt: "" } }, config, undefined)).toEqual({ model: BIG, effort: "medium" });
  });

  it("never sends effort to a model without it", () => {
    expect(resolveChoice({ model: NO_EFFORT, effort: "high" }, config, undefined)).toEqual({ model: NO_EFFORT, effort: null });
  });

  it("keeps the stored choice when the request names none, if MODELS still lists it", () => {
    expect(resolveChoice({}, config, { model: SMALL, effort: "high" })).toEqual({ model: SMALL, effort: "high" });
    expect(resolveChoice(undefined, config, { model: "@cf/removed/model", effort: "high" })).toEqual({ model: BIG, effort: "medium" });
  });
});

async function messagesOf(chatId: string): Promise<UIMessage[]> {
  const stub = await getAgentByName(e.BilincAgent, chatId);
  return runInDurableObject(stub, (agent) => agent.getMessages());
}

async function stateOf(chatId: string): Promise<unknown> {
  const stub = await getAgentByName(e.BilincAgent, chatId);
  return runInDurableObject(stub, (agent) => agent.state);
}

async function connect(chatId: string): Promise<WebSocket> {
  const res = await handleRequest(
    new Request(`https://agent.test/agents/bilinc-agent/${chatId}`, { headers: { Upgrade: "websocket", Cookie: await sessionCookie() } }),
    e,
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/** One chat request with `extra` body fields, framed as useAgentChat frames it; waits for the reply. */
async function ask(chatId: string, extra: Record<string, unknown>, text = "hello"): Promise<void> {
  scriptModel([{ text: "ok" }]);
  const earlier = await messagesOf(chatId);
  const ws = await connect(chatId);
  ws.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: { method: "POST", body: JSON.stringify({ messages: [...earlier, userMessage(text)], trigger: "submit-message", ...extra }) },
    }),
  );
  await waitFor(
    () => messagesOf(chatId),
    (msgs) => msgs.length >= earlier.length + 2 && msgs.at(-1)?.role === "assistant",
  );
  ws.close();
}

describe("model choice per chat", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
    setAgentEnv({ AUTO_CHECKPOINT: "false" });
    recordedChoices().splice(0);
  });
  afterEach(() => {
    bilinc.restore();
    setAgentEnv(undefined);
  });

  it("runs the turn on the requested model and effort and stores them for the chat", async () => {
    const chatId = crypto.randomUUID();
    await ask(chatId, { model: SMALL, effort: "high" });
    expect(recordedChoices().at(-1)).toEqual({ model: SMALL, effort: "high" });
    expect(await stateOf(chatId)).toEqual({ model: SMALL, effort: "high" });
  });

  it("keeps the stored choice for a request that names none", async () => {
    const chatId = crypto.randomUUID();
    await ask(chatId, { model: SMALL, effort: "low" });
    await ask(chatId, {}, "again");
    expect(recordedChoices().at(-1)).toEqual({ model: SMALL, effort: "low" });
  });

  it("runs MODEL for a model outside MODELS, never the client's string", async () => {
    const chatId = crypto.randomUUID();
    await ask(chatId, { model: "@cf/evil/model", effort: "high" });
    expect(recordedChoices().map((c) => c.model)).not.toContain("@cf/evil/model");
    expect(recordedChoices().at(-1)).toEqual({ model: BIG, effort: "high" });
  });

  it("ignores state the page tries to write", async () => {
    const chatId = crypto.randomUUID();
    await ask(chatId, { model: SMALL, effort: "low" });
    const ws = await connect(chatId);
    ws.send(JSON.stringify({ type: "cf_agent_state", state: { model: "@cf/evil/model", effort: "high" } }));
    await new Promise((r) => setTimeout(r, 200));
    ws.close();
    expect(await stateOf(chatId)).toEqual({ model: SMALL, effort: "low" });
  });
});

describe("GET /api/models", () => {
  it("returns MODEL and the validated allowlist behind the gate", async () => {
    const res = await handleRequest(new Request("https://agent.test/api/models", { headers: { Cookie: await sessionCookie() } }), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { default: string; models: { id: string }[] };
    expect(body).toEqual({ default: BIG, models: parseModels(e.MODELS, e.MODEL).models });
    expect(body.models.map((m) => m.id)).toEqual([BIG, SMALL]);
  });

  it("answers 401 without the session cookie", async () => {
    const res = await handleRequest(new Request("https://agent.test/api/models"), e);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
