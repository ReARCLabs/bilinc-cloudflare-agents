// A scripted language model from ai/test. It lives on globalThis because the agent's
// Durable Object and the test share one isolate but may hold separate module instances.
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

export type CallOptions = MockLanguageModelV4["doStreamCalls"][number];
type StreamPart = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;

export type ToolInput = Record<string, unknown>;
export type ToolCallStep = { toolName: string; input: ToolInput | ((options: CallOptions) => ToolInput) };
export type Step = { text: string } | { toolCalls: ToolCallStep[] };

const KEY = "__bilincTestModel";
const g = globalThis as unknown as Record<string, unknown>;
let callCounter = 0;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** Each model call takes the next step; with no steps left it answers "ok". */
export function scriptModel(steps: Step[]): MockLanguageModelV4 {
  const queue = [...steps];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const step = queue.shift() ?? { text: "ok" };
      const parts: StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if ("text" in step) {
        parts.push(
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: step.text },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        );
      } else {
        for (const call of step.toolCalls) {
          const input = typeof call.input === "function" ? (call.input as (o: CallOptions) => unknown)(options) : call.input;
          parts.push({ type: "tool-call", toolCallId: `call-${++callCounter}`, toolName: call.toolName, input: JSON.stringify(input) });
        }
        parts.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage });
      }
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
  g[KEY] = model;
  return model;
}

export function currentModel(): MockLanguageModelV4 {
  return (g[KEY] as MockLanguageModelV4 | undefined) ?? scriptModel([]);
}

/** The JSON output of the most recent result of `toolName` in the prompt the model received. */
export function lastToolOutput(options: CallOptions, toolName: string): Record<string, unknown> {
  for (const message of [...options.prompt].reverse()) {
    if (message.role !== "tool") continue;
    for (const part of [...message.content].reverse()) {
      if (part.type === "tool-result" && part.toolName === toolName && part.output.type === "json") {
        return part.output.value as Record<string, unknown>;
      }
    }
  }
  throw new Error(`no ${toolName} result in the prompt`);
}

export function toolNamesOffered(model: MockLanguageModelV4, call = 0): string[] {
  return (model.doStreamCalls[call]?.tools ?? []).map((t) => t.name).sort();
}

export function systemPromptSent(model: MockLanguageModelV4, call = 0): string {
  const system = model.doStreamCalls[call]?.prompt.find((m) => m.role === "system");
  return system && typeof system.content === "string" ? system.content : "";
}
