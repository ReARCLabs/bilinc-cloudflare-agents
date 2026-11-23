import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { Bilinc } from "bilinc-cloudflare-agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_CHECKPOINT_FLAG } from "../src/constants";
import { bilincError, deferredResponse, htmlPage, installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { scriptModel } from "./helpers/mock-model";
import { setAgentEnv } from "./helpers/test-agent";
import { userMessage, waitFor } from "./helpers/turns";

const e = env as unknown as Env;

async function readFlag(chatId: string): Promise<string | undefined> {
  const stub = await getAgentByName(e.BilincAgent, chatId);
  return runInDurableObject(stub, (_agent, state) => state.storage.get<string>(AUTO_CHECKPOINT_FLAG));
}

async function wake(chatId: string): Promise<void> {
  const stub = await getAgentByName(e.BilincAgent, chatId);
  await evictDurableObject(stub);
  await getAgentByName(e.BilincAgent, chatId);
}

describe("automatic checkpoint at chat start", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
    setAgentEnv({ AUTO_CHECKPOINT: "true" });
    scriptModel([]);
  });
  afterEach(() => {
    bilinc.restore();
    setAgentEnv(undefined);
  });
  const snapshotPosts = () => bilinc.callsTo("POST", "/memory/snapshots");

  it("creates one labelled snapshot, sets done, and never repeats it", async () => {
    const chatId = crypto.randomUUID();
    await getAgentByName(e.BilincAgent, chatId);
    expect(await waitFor(() => readFlag(chatId), (f) => f === "done")).toBe("done");
    expect(snapshotPosts()).toHaveLength(1);
    expect(String(snapshotPosts()[0]!.body!.label)).toMatch(/^auto: chat start \d{4}-\d{2}-\d{2}T/);
    await wake(chatId);
    await wake(chatId);
    expect(snapshotPosts()).toHaveLength(1);
  });

  it("does not hold up startup or the first turn while the snapshot is pending", async () => {
    const hang = deferredResponse();
    bilinc.override("POST /memory/snapshots", hang.handler);
    scriptModel([{ text: "hello there" }]);
    const chatId = crypto.randomUUID();
    const stub = await getAgentByName(e.BilincAgent, chatId);
    const reply = await runInDurableObject(stub, async (agent, state) => {
      expect(await state.storage.get(AUTO_CHECKPOINT_FLAG)).toBe("pending");
      await agent.saveMessages([userMessage("hi")]);
      return (await agent.getMessages()).at(-1);
    });
    expect(JSON.stringify(reply)).toContain("hello there");
    expect(snapshotPosts()).toHaveLength(1);
    hang.release();
    expect(await waitFor(() => readFlag(chatId), (f) => f === "done")).toBe("done");
  });

  it("sets unknown after an outcome-unknown attempt and does not repeat it", async () => {
    bilinc.override("POST /memory/snapshots", () => htmlPage(502));
    const chatId = crypto.randomUUID();
    await getAgentByName(e.BilincAgent, chatId);
    expect(await waitFor(() => readFlag(chatId), (f) => f === "unknown")).toBe("unknown");
    await wake(chatId);
    expect(snapshotPosts()).toHaveLength(1);
  });

  it("sets unknown and sends nothing when a wake finds pending", async () => {
    setAgentEnv({ AUTO_CHECKPOINT: "false" });
    const chatId = crypto.randomUUID();
    const stub = await getAgentByName(e.BilincAgent, chatId);
    await runInDurableObject(stub, (_agent, state) => state.storage.put(AUTO_CHECKPOINT_FLAG, "pending"));
    setAgentEnv({ AUTO_CHECKPOINT: "true" });
    await wake(chatId);
    expect(await readFlag(chatId)).toBe("unknown");
    expect(snapshotPosts()).toHaveLength(0);
  });

  it("deletes the flag after a definite refusal, and the next wake tries once more", async () => {
    bilinc.override("POST /memory/snapshots", () => bilincError(402, "payment_required"));
    const chatId = crypto.randomUUID();
    await getAgentByName(e.BilincAgent, chatId);
    await waitFor(() => readFlag(chatId), (f) => f === undefined && snapshotPosts().length === 1);
    bilinc.clearOverrides();
    await wake(chatId);
    expect(await waitFor(() => readFlag(chatId), (f) => f === "done")).toBe("done");
    expect(snapshotPosts()).toHaveLength(2);
  });

  it("deletes the flag when the attempt was never sent (rate cap)", async () => {
    setAgentEnv({ AUTO_CHECKPOINT: "false" });
    const chatId = crypto.randomUUID();
    const stub = await getAgentByName(e.BilincAgent, chatId);
    const flag = await runInDurableObject(stub, async (agent, state) => {
      const bilincInstance = (agent as unknown as { bilinc: Bilinc }).bilinc;
      for (let i = 0; i < 20; i++) await bilincInstance.client.recall({ query: "warm up the cap" });
      await state.storage.put(AUTO_CHECKPOINT_FLAG, "pending");
      await agent.runAutoCheckpoint();
      return state.storage.get(AUTO_CHECKPOINT_FLAG);
    });
    expect(flag).toBeUndefined();
    expect(snapshotPosts()).toHaveLength(0);
  });

  it("sends nothing when AUTO_CHECKPOINT is false", async () => {
    setAgentEnv({ AUTO_CHECKPOINT: "false" });
    const chatId = crypto.randomUUID();
    await getAgentByName(e.BilincAgent, chatId);
    await wake(chatId);
    expect(await readFlag(chatId)).toBeUndefined();
    expect(snapshotPosts()).toHaveLength(0);
  });

  it("never blocks the chat when Bilinc is down", async () => {
    bilinc.override("POST /memory/snapshots", () => {
      throw new TypeError("network down");
    });
    scriptModel([{ text: "still here" }]);
    const chatId = crypto.randomUUID();
    const stub = await getAgentByName(e.BilincAgent, chatId);
    const last = await runInDurableObject(stub, async (agent) => {
      await agent.saveMessages([userMessage("hi")]);
      return (await agent.getMessages()).at(-1);
    });
    expect(JSON.stringify(last)).toContain("still here");
  });
});
