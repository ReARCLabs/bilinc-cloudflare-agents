// Rejecting a forget or rollback in the UI, over the chat's WebSocket exactly as the browser
// sends it: both kinds of Reject must start the next model turn, and a typed reason must reach
// the model. The UI test checks that the Chat sends these frames; this one checks what Think does.
import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolUIPart } from "ai";
import { partSteps } from "../src/client/steps";
import { rejectedByUserOutput } from "../src/constants";
import { handleRequest } from "../src/server";
import { installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { currentModel, scriptModel } from "./helpers/mock-model";
import { sessionCookie } from "./helpers/session";
import { setAgentEnv } from "./helpers/test-agent";
import { toolParts, userMessage, waitFor } from "./helpers/turns";

const e = env as unknown as Env;

async function messagesOf(chatId: string): Promise<UIMessage[]> {
  const stub = await getAgentByName(e.BilincAgent, chatId);
  return runInDurableObject(stub, (agent) => agent.getMessages());
}

async function connect(chatId: string): Promise<WebSocket> {
  const res = await handleRequest(
    new Request(`https://agent.test/agents/bilinc-agent/${chatId}`, {
      headers: { Upgrade: "websocket", Cookie: await sessionCookie() },
    }),
    e,
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/** A chat whose last turn asked to forget `old-fact` and now waits for the user. */
async function pendingForget(): Promise<{ chatId: string; toolCallId: string }> {
  scriptModel([
    { toolCalls: [{ toolName: "bilinc_forget", input: { key: "old-fact", reason: "it is wrong" } }] },
    { text: "Understood, I kept it." },
  ]);
  const chatId = crypto.randomUUID();
  const stub = await getAgentByName(e.BilincAgent, chatId);
  const messages = await runInDurableObject(stub, async (agent) => {
    await agent.saveMessages([userMessage("forget the old fact")]);
    return agent.getMessages();
  });
  const part = toolParts(messages, "bilinc_forget")[0] as { state: string; toolCallId: string };
  expect(part.state).toBe("approval-requested");
  return { chatId, toolCallId: part.toolCallId };
}

describe("Reject in the UI", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
    setAgentEnv({ AUTO_CHECKPOINT: "false" });
  });
  afterEach(() => {
    bilinc.restore();
    setAgentEnv(undefined);
  });

  async function rejectAndWait(frame: (toolCallId: string) => unknown) {
    const { chatId, toolCallId } = await pendingForget();
    const model = currentModel();
    expect(model.doStreamCalls).toHaveLength(1);
    const ws = await connect(chatId);
    ws.send(JSON.stringify(frame(toolCallId)));
    const messages = await waitFor(
      () => messagesOf(chatId),
      (msgs) => JSON.stringify(msgs.at(-1)).includes("Understood, I kept it."),
    );
    ws.close();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(bilinc.callsTo("POST", "/memory/forget")).toHaveLength(0);
    return { messages, prompt: JSON.stringify(model.doStreamCalls[1]!.prompt) };
  }

  it("continues after a plain Reject (an approval response with approved: false)", async () => {
    // The frame addToolApprovalResponse({ id, approved: false }) sends.
    const { messages } = await rejectAndWait((toolCallId) => ({ type: "cf_agent_tool_approval", toolCallId, approved: false, autoContinue: true }));
    expect(toolParts(messages, "bilinc_forget")[0]!.state).toBe("output-denied");
  });

  it("continues after a Reject with a reason, and the model sees the reason", async () => {
    // The frame addToolOutput({ toolCallId, toolName, output: rejectedByUserOutput(reason) }) sends.
    const { messages, prompt } = await rejectAndWait((toolCallId) => ({
      type: "cf_agent_tool_result",
      toolCallId,
      toolName: "bilinc_forget",
      output: rejectedByUserOutput("keep it, it is right"),
      autoContinue: true,
    }));
    expect(toolParts(messages, "bilinc_forget")[0]).toMatchObject({ state: "output-available", output: rejectedByUserOutput("keep it, it is right") });
    expect(prompt).toContain("keep it, it is right");
    expect(prompt).toContain("rejected by the user");
  });

  it("keeps approved: true on the stored output of an approved forget, so the step list shows the approval", async () => {
    const { chatId, toolCallId } = await pendingForget();
    const ws = await connect(chatId);
    ws.send(JSON.stringify({ type: "cf_agent_tool_approval", toolCallId, approved: true, autoContinue: true }));
    const messages = await waitFor(
      () => messagesOf(chatId),
      (msgs) => JSON.stringify(msgs.at(-1)).includes("Understood, I kept it."),
    );
    ws.close();
    const part = toolParts(messages, "bilinc_forget")[0] as unknown as ToolUIPart;
    expect(part.state).toBe("output-available");
    expect((part as { approval?: { approved?: boolean } }).approval?.approved).toBe(true);
    expect(partSteps(part)[0]).toMatchObject({ status: "done", label: 'You approved forgetting "old-fact"' });
  });
});
