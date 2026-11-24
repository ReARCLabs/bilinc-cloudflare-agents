import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { BilincError, type Bilinc } from "bilinc-cloudflare-agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoCheckpointEnabled, autoCheckpointMayExist } from "../src/agent";
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

  it.each(["mutation_outcome_unknown", "cloud_runtime_unavailable"])(
    "sets unknown after Bilinc's own outcome-unknown code %s and does not repeat it",
    async (code) => {
      bilinc.override("POST /memory/snapshots", () => bilincError(503, code));
      const chatId = crypto.randomUUID();
      await getAgentByName(e.BilincAgent, chatId);
      expect(await waitFor(() => readFlag(chatId), (f) => f === "unknown")).toBe("unknown");
      bilinc.clearOverrides();
      await wake(chatId);
      expect(snapshotPosts()).toHaveLength(1);
    },
  );

  it.each([
    [500, "internal_error"],
    [502, "upstream_error"],
  ])("deletes the flag after a JSON %i with another code, so the next wake tries once more", async (status, code) => {
    bilinc.override("POST /memory/snapshots", () => bilincError(status, code));
    const chatId = crypto.randomUUID();
    await getAgentByName(e.BilincAgent, chatId);
    await waitFor(() => readFlag(chatId), (f) => f === undefined && snapshotPosts().length === 1);
    expect(await readFlag(chatId)).toBeUndefined();
    bilinc.clearOverrides();
    await wake(chatId);
    expect(await waitFor(() => readFlag(chatId), (f) => f === "done")).toBe("done");
    expect(snapshotPosts()).toHaveLength(2);
  });

  it("treats only a JSON 5xx with a code other than Bilinc's two outcome-unknown codes as not applied", () => {
    const unknown = (code: string, status: number) => new BilincError({ code, status, outcomeUnknown: true });
    for (const error of [
      unknown("timeout", 0),
      unknown("network", 0),
      unknown("bad_response", 502),
      unknown("bad_response", 200),
      unknown("idempotency_conflict", 409),
      unknown("mutation_outcome_unknown", 503),
      unknown("cloud_runtime_unavailable", 503),
    ]) {
      expect(autoCheckpointMayExist(error), `${error.code} ${error.status}`).toBe(true);
    }
    for (const error of [
      unknown("internal_error", 500),
      unknown("upstream_error", 502),
      new BilincError({ code: "payment_required", status: 402 }),
      new BilincError({ code: "capability_unavailable", status: 503 }),
      new TypeError("setup failed"),
    ]) {
      expect(autoCheckpointMayExist(error), String(error)).toBe(false);
    }
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

  /** Run the checkpoint by hand with storage.put failing for the first `failures` writes of "done". */
  async function runWithDoneWriteFailing(chatId: string, failures: number): Promise<unknown> {
    const stub = await getAgentByName(e.BilincAgent, chatId);
    return runInDurableObject(stub, async (agent, state) => {
      await state.storage.put(AUTO_CHECKPOINT_FLAG, "pending");
      const storage = state.storage as unknown as { put(...args: unknown[]): Promise<void> };
      const realPut = storage.put.bind(state.storage);
      let left = failures;
      storage.put = async (...args: unknown[]) => {
        if (args[0] === AUTO_CHECKPOINT_FLAG && args[1] === "done" && left-- > 0) throw new Error("storage write failed");
        return realPut(...args);
      };
      try {
        await agent.runAutoCheckpoint();
      } finally {
        delete (storage as { put?: unknown }).put;
      }
      return state.storage.get(AUTO_CHECKPOINT_FLAG);
    });
  }

  it("stores done on the second try when the first write after a created checkpoint fails", async () => {
    setAgentEnv({ AUTO_CHECKPOINT: "false" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await runWithDoneWriteFailing(crypto.randomUUID(), 1)).toBe("done");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(snapshotPosts()).toHaveLength(1);
  });

  it("never deletes the flag after a created checkpoint, so a failed done write does not lead to a second checkpoint", async () => {
    setAgentEnv({ AUTO_CHECKPOINT: "false" });
    const chatId = crypto.randomUUID();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await runWithDoneWriteFailing(chatId, 2)).toBe("pending");
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        "[bilinc] automatic checkpoint created, but its flag could not be stored as done; the next wake marks it unknown and creates no second one",
      ]);
    } finally {
      warn.mockRestore();
    }
    setAgentEnv({ AUTO_CHECKPOINT: "true" });
    await wake(chatId);
    await wake(chatId);
    expect(await readFlag(chatId)).toBe("unknown");
    expect(snapshotPosts()).toHaveLength(1);
  });

  it("sends nothing when AUTO_CHECKPOINT is false", async () => {
    setAgentEnv({ AUTO_CHECKPOINT: "false" });
    const chatId = crypto.randomUUID();
    await getAgentByName(e.BilincAgent, chatId);
    await wake(chatId);
    expect(await readFlag(chatId)).toBeUndefined();
    expect(snapshotPosts()).toHaveLength(0);
  });

  it("reads AUTO_CHECKPOINT as off for false, 0, off and no in any case and with spaces, and as on otherwise", () => {
    for (const off of ["false", "FALSE", " False ", "0", "off", "Off", "no", "NO\n", false, 0]) {
      expect(autoCheckpointEnabled(off), JSON.stringify(off)).toBe(false);
    }
    for (const on of [undefined, "", "true", "TRUE", "1", "yes", "on", true, 1, "falsey"]) {
      expect(autoCheckpointEnabled(on), JSON.stringify(on)).toBe(true);
    }
  });

  it("sends nothing when AUTO_CHECKPOINT is written another way of saying off", async () => {
    for (const off of [" FALSE ", "0", "off", "No", false]) {
      setAgentEnv({ AUTO_CHECKPOINT: off as unknown as string });
      const chatId = crypto.randomUUID();
      await getAgentByName(e.BilincAgent, chatId);
      await wake(chatId);
      expect(await readFlag(chatId)).toBeUndefined();
    }
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
