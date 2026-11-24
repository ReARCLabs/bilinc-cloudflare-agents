// The agent builds its model with createAI from agents/models/ai-sdk. These tests call the real
// BilincAgent.languageModel (TestAgent overrides it) against a fake AI binding and read what
// would reach Workers AI.
import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BilincAgent } from "../src/agent";
import type { ModelChoice } from "../src/models";
import { installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { recordedChoices } from "./helpers/test-agent";

const e = env as unknown as Env;

interface RunCall {
  model: string;
  input: Record<string, unknown>;
  options: { extraHeaders?: Record<string, string> };
}

function fakeAI(): { binding: Ai; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const binding = {
    run: async (model: string, input: Record<string, unknown>, options: RunCall["options"]) => {
      calls.push({ model, input, options });
      const body = {
        id: "x",
        object: "chat.completion",
        created: 0,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  };
  return { binding: binding as unknown as Ai, calls };
}

type BuiltModel = { provider: string; doGenerate(options: unknown): Promise<unknown> };

/** The real BilincAgent.languageModel, called on a stand-in `this` that has only what it reads. */
function realModel(binding: Ai, choice: ModelChoice): BuiltModel {
  const self = { env: { AI: binding }, sessionAffinity: "affinity-1" };
  const proto = BilincAgent.prototype as unknown as { languageModel(this: unknown, c: ModelChoice): BuiltModel };
  return proto.languageModel.call(self, choice);
}

const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

describe("model provider", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
    recordedChoices().splice(0);
  });
  afterEach(() => bilinc.restore());

  it("builds the model through createAI and sends reasoning_effort and session affinity to env.AI.run", async () => {
    const { binding, calls } = fakeAI();
    const model = realModel(binding, { model: "@cf/openai/gpt-oss-120b", effort: "low" });
    expect(model.provider).toBe("cloudflare");
    await model.doGenerate({ prompt });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("@cf/openai/gpt-oss-120b");
    expect(calls[0]!.input.reasoning_effort).toBe("low");
    expect(calls[0]!.options.extraHeaders).toEqual({ "x-session-affinity": "affinity-1" });
  });

  it("sends no reasoning_effort for a choice without effort", async () => {
    const { binding, calls } = fakeAI();
    await realModel(binding, { model: "@cf/meta/llama-4-scout-17b-16e-instruct", effort: null }).doGenerate({ prompt });
    expect(calls[0]!.model).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
    expect("reasoning_effort" in calls[0]!.input).toBe(false);
  });

  it("getModel() builds MODEL through languageModel()", async () => {
    const stub = await getAgentByName(e.BilincAgent, crypto.randomUUID());
    await runInDurableObject(stub, (agent) => {
      agent.getModel();
    });
    expect(recordedChoices().at(-1)).toEqual({ model: "@cf/openai/gpt-oss-120b", effort: null });
  });
});
