// The README demo script, end to end: gate, routing, Think, the package and both chats,
// against the in-memory Bilinc mock and a scripted model. No credentials, no neurons.
import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/server";
import { installMockBilinc, type MockBilinc } from "./helpers/mock-bilinc";
import { lastToolOutput, scriptModel, type Step } from "./helpers/mock-model";
import { sessionCookie } from "./helpers/session";
import { setAgentEnv } from "./helpers/test-agent";
import { toolParts, userMessage, waitFor } from "./helpers/turns";

const e = env as unknown as Env;
const KEY = "cf.default.favourite-colour";

async function say(chatId: string, text: string, steps: Step[]): Promise<UIMessage[]> {
  scriptModel(steps);
  const stub = await getAgentByName(e.BilincAgent, chatId);
  return runInDurableObject(stub, async (agent) => {
    await agent.saveMessages([userMessage(text)]);
    return agent.getMessages();
  });
}

async function messagesOf(chatId: string): Promise<UIMessage[]> {
  const stub = await getAgentByName(e.BilincAgent, chatId);
  return runInDurableObject(stub, (agent) => agent.getMessages());
}

/** Open the chat's WebSocket through the Worker, exactly as the browser does. */
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

const setColour = (colour: string): Step => ({
  toolCalls: [
    {
      toolName: "set_context",
      input: { label: "memory", content: `The user's favourite colour is ${colour}.`, metadata: { title: "Favourite colour" } },
    },
  ],
});

describe("demo script", () => {
  let bilinc: MockBilinc;
  beforeEach(() => {
    bilinc = installMockBilinc();
    setAgentEnv({ AUTO_CHECKPOINT: "true" });
  });
  afterEach(() => {
    bilinc.restore();
    setAgentEnv(undefined);
  });

  it("saves, checkpoints, diffs, rolls back with approval, and the next chat sees the original value", async () => {
    const chatA = crypto.randomUUID();

    // 1. Tell the agent a fact.
    await say(chatA, "My favourite colour is green.", [setColour("green"), { text: "Noted." }]);
    expect(bilinc.value(KEY)).toBe("The user's favourite colour is green.");
    await waitFor(async () => bilinc.snapshotLabels(), (labels) => labels.length === 1);

    // 2. "checkpoint now": the result carries the checkpoint id.
    let messages = await say(chatA, "checkpoint now", [
      { toolCalls: [{ toolName: "bilinc_checkpoint", input: { label: "before colour change" } }] },
      { text: "Checkpoint created." },
    ]);
    const checkpoint = toolParts(messages, "bilinc_checkpoint")[0]!.output as { id: string; label: string };
    expect(checkpoint.label).toBe("before colour change");
    expect(checkpoint.id).toMatch(/^snap_/);

    // 3. Correct the fact with a wrong value (same title, so a new version of the same key).
    await say(chatA, "Actually my favourite colour is red.", [setColour("red"), { text: "Updated." }]);
    expect(bilinc.value(KEY)).toBe("The user's favourite colour is red.");

    // 4. "diff against the checkpoint" shows one modified key.
    messages = await say(chatA, "diff against the checkpoint", [
      { toolCalls: [{ toolName: "bilinc_diff", input: (o) => ({ snapshotId: lastToolOutput(o, "bilinc_checkpoint").id }) }] },
      { text: "One entry changed." },
    ]);
    expect(toolParts(messages, "bilinc_diff")[0]!.output).toMatchObject({
      counts: { added: 0, modified: 1, removed: 0 },
      modified: ["favourite-colour"],
    });

    // 5. "roll back to the checkpoint": preview, then a rollback that waits for the user.
    messages = await say(chatA, "roll back to the checkpoint", [
      {
        toolCalls: [
          {
            toolName: "bilinc_rollback_preview",
            input: (o) => ({ snapshotId: lastToolOutput(o, "bilinc_checkpoint").id, reason: "undo the colour change" }),
          },
        ],
      },
      { toolCalls: [{ toolName: "bilinc_rollback", input: (o) => ({ previewId: lastToolOutput(o, "bilinc_rollback_preview").previewId }) }] },
      { text: "Rolled back." },
    ]);
    const preview = toolParts(messages, "bilinc_rollback_preview")[0]!.output as Record<string, unknown>;
    // The key lists hold suffixes, the keys bilinc_history and bilinc_forget accept.
    expect(preview).toMatchObject({ counts: { create: 0, update: 1, remove: 0 }, updateKeys: [KEY.slice("cf.default.".length)], outsideNamespace: 0 });
    expect(JSON.stringify(preview)).not.toContain("tok_");
    const pending = toolParts(messages, "bilinc_rollback")[0] as { state: string; toolCallId?: string };
    expect(pending.state).toBe("approval-requested");
    expect(bilinc.callsTo("POST", "/memory/rollback")).toHaveLength(0);
    expect(bilinc.value(KEY)).toBe("The user's favourite colour is red.");

    // The user approves in the UI: the browser sends the approval over the chat's WebSocket.
    const ws = await connect(chatA);
    const rollbackPart = (await messagesOf(chatA))
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool-bilinc_rollback") as { toolCallId: string };
    ws.send(JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: rollbackPart.toolCallId, approved: true, autoContinue: true }));
    const done = await waitFor(
      () => messagesOf(chatA),
      (msgs) => toolParts(msgs, "bilinc_rollback")[0]?.state === "output-available",
    );
    ws.close();
    expect(toolParts(done, "bilinc_rollback")[0]!.output).toMatchObject({ rolledBack: true, counts: { updated: 1 } });
    expect(bilinc.callsTo("POST", "/memory/rollback")).toHaveLength(1);
    expect(bilinc.value(KEY)).toBe("The user's favourite colour is green.");

    // 6. New chat: a new Durable Object, its own automatic checkpoint, the same memory.
    const chatB = crypto.randomUUID();
    messages = await say(chatB, "What is my favourite colour?", [
      { toolCalls: [{ toolName: "search_context", input: { label: "memory", query: "favourite colour" } }] },
      { text: "Green." },
    ]);
    expect(JSON.stringify(toolParts(messages, "search_context")[0]!.output)).toContain("green");
    expect(messages.some((m) => JSON.stringify(m).includes("checkpoint now"))).toBe(false);
    await waitFor(async () => bilinc.snapshotLabels(), (labels) => labels.length === 3);

    // 7. "list checkpoints" shows the manual checkpoint and both chats' automatic ones.
    messages = await say(chatB, "list checkpoints", [
      { toolCalls: [{ toolName: "bilinc_checkpoints", input: {} }] },
      { text: "Here they are." },
    ]);
    const listed = toolParts(messages, "bilinc_checkpoints")[0]!.output as { checkpoints: { label: string }[] };
    const labels = listed.checkpoints.map((c) => c.label);
    expect(labels.filter((l) => l.startsWith("auto: chat start "))).toHaveLength(2);
    expect(labels).toContain("before colour change");

    // 8. The automatic checkpoint is usable: diff and rollback preview accept its id.
    const autoId = (o: Parameters<typeof lastToolOutput>[0]) =>
      (lastToolOutput(o, "bilinc_checkpoints").checkpoints as { id: string; label: string }[]).find((c) =>
        c.label.startsWith("auto: chat start "),
      )!.id;
    messages = await say(chatB, "diff against my chat-start checkpoint and preview rolling back to it", [
      {
        toolCalls: [
          { toolName: "bilinc_diff", input: (o) => ({ snapshotId: autoId(o) }) },
          { toolName: "bilinc_rollback_preview", input: (o) => ({ snapshotId: autoId(o), reason: "inspect the chat start" }) },
        ],
      },
      { text: "Nothing changed since then." },
    ]);
    expect(toolParts(messages, "bilinc_diff").at(-1)!.output).toMatchObject({ counts: { added: 0, modified: 0, removed: 0 } });
    expect(toolParts(messages, "bilinc_rollback_preview").at(-1)!.output).toMatchObject({
      counts: { create: 0, update: 0, remove: 0 },
    });
  });
});
