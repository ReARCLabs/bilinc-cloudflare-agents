import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_TOOLS, WORKSPACE_CAPABILITY_LINE } from "../src/constants";
import { stripWorkspaceLine } from "../src/agent";
import { installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { scriptModel, systemPromptSent, toolNamesOffered } from "./helpers/mock-model";
import { recordedTurns, setAgentEnv, type TestAgent } from "./helpers/test-agent";
import { toolParts, userMessage } from "./helpers/turns";

const e = env as unknown as Env;
const ALLOWED = [...ACTIVE_TOOLS].sort();

describe("hidden workspace tools", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
    setAgentEnv(undefined);
  });
  afterEach(() => bilinc.restore());

  it("stripWorkspaceLine removes exactly that line", () => {
    expect(stripWorkspaceLine(`a\n${WORKSPACE_CAPABILITY_LINE}\nb`)).toBe("a\nb");
    expect(stripWorkspaceLine(`a\n${WORKSPACE_CAPABILITY_LINE} extra\nb`)).toBe(`a\n${WORKSPACE_CAPABILITY_LINE} extra\nb`);
  });

  it("offers only the nine allowed tools, runs no workspace write, and drops the capability line", async () => {
    const model = scriptModel([
      { toolCalls: [{ toolName: "write", input: { path: "/hacked.txt", content: "x" } }] },
      { text: "done" },
    ]);
    const chatId = crypto.randomUUID();
    const stub = await getAgentByName(e.BilincAgent, chatId);
    const result = await runInDurableObject(stub, async (agent) => {
      await agent.saveMessages([userMessage("write a file")]);
      const file = await agent.workspace.fs.stat("/hacked.txt").then(
        () => "exists",
        () => "missing",
      );
      return { file, messages: await agent.getMessages() };
    });

    expect(toolNamesOffered(model, 0)).toEqual(ALLOWED);
    expect(toolNamesOffered(model, 1)).toEqual(ALLOWED);
    expect(result.file).toBe("missing");
    expect(toolParts(result.messages, "write").map((p) => p.state)).toEqual(["output-error"]);

    const turns = recordedTurns().filter((t) => t.name === chatId);
    expect(turns[0]!.system).toContain(WORKSPACE_CAPABILITY_LINE);
    expect(turns.every((t) => [...(t.activeTools ?? [])].sort().join() === ALLOWED.join())).toBe(true);
    expect(systemPromptSent(model, 0)).not.toContain(WORKSPACE_CAPABILITY_LINE);
    expect(systemPromptSent(model, 0)).toContain("Always pass metadata.title");
  });

  it("applies the allowlist on a continuation turn too", async () => {
    scriptModel([{ text: "first" }, { text: "continued" }]);
    const chatId = crypto.randomUUID();
    const stub = await getAgentByName(e.BilincAgent, chatId);
    await runInDurableObject(stub, async (agent) => {
      await agent.saveMessages([userMessage("hello")]);
      await (agent as TestAgent).continueTurn();
    });
    const turns = recordedTurns().filter((t) => t.name === chatId);
    expect(turns.map((t) => t.continuation)).toEqual([false, true]);
    for (const t of turns) expect([...(t.activeTools ?? [])].sort()).toEqual(ALLOWED);
  });
});
