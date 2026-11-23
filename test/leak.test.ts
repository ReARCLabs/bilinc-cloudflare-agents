import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBilinc } from "../src/index";
import type { Bilinc } from "../src/index";
import type { BilincMemoryProvider } from "../src/provider";
import { bilincTools } from "../src/tools";
import type { BilincToolStore } from "../src/tools";
import { json, mockFetch } from "./helpers/mock-fetch";
import type { MockFetch, Responder } from "./helpers/mock-fetch";

const KEY = "bil_live_LEAKCANARY_7f3e9a";

/** Every answer tries to leak the key: in the JSON message, in details, in an HTML page and in a rejection. */
const hostile: Responder[] = [
  json(500, { error: "internal_error", message: `bad key ${KEY}`, requestId: "req_leak", retryable: true, details: { echo: KEY } }),
  () => new Response(`<html>${KEY}</html>`, { status: 502, headers: { "Content-Type": "text/html" } }),
  () => Promise.reject(new TypeError(`connect failed for Bearer ${KEY}`)),
  json(401, { error: "invalid_api_key", message: `key ${KEY} is invalid`, requestId: "req_leak2", retryable: false }),
];

/** A store that already holds preview p1, so bilinc_rollback reaches the network. */
function store(): BilincToolStore {
  const map = new Map<string, unknown>([
    ["bilinc:rollbackPreview:p1", { snapshotId: "snap_1", confirmationToken: "tok", reason: "r", expiresAt: Date.now() + 300_000 }],
  ]);
  return {
    get: <T>(k: string) => Promise.resolve(map.get(k) as T | undefined),
    put: (k: string, v: unknown) => Promise.resolve(void map.set(k, v)),
    delete: (k: string) => Promise.resolve(map.delete(k)),
  };
}

const TOOL_INPUTS: Record<string, unknown> = {
  bilinc_checkpoint: { label: "x" },
  bilinc_checkpoints: {},
  bilinc_diff: { snapshotId: "snap_1" },
  bilinc_history: { key: "a" },
  bilinc_forget: { key: "a", reason: "r" },
  bilinc_rollback_preview: { snapshotId: "snap_1", reason: "r" },
  bilinc_rollback: { previewId: "p1" },
};

/** What a model, a log line or a thrown message can show: messages, stacks and causes, never `details`. */
function texts(value: unknown): string {
  if (value instanceof Error) return [value.message, String(value), value.stack ?? "", texts(value.cause)].join("\n");
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** Every call gets a fresh instance (fresh breaker), and must reach fetch, so no answer is hidden by an open breaker. */
async function sentCall(m: MockFetch, call: (bilinc: Bilinc) => Promise<unknown>): Promise<unknown> {
  const before = m.sent.length;
  const output = await call(createBilinc({ apiKey: KEY }));
  expect(m.sent.length).toBeGreaterThan(before);
  return output;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the API key never leaves the Authorization header", () => {
  it.each(hostile.map((responder, index) => [index, responder] as const))("hostile answer #%i", async (_index, responder) => {
    const m = mockFetch(responder);
    const provider = (bilinc: Bilinc) => bilinc.memoryBlock().provider as BilincMemoryProvider;
    const outputs: unknown[] = [
      await sentCall(m, (b) => provider(b).get()),
      await sentCall(m, (b) => provider(b).search("q")),
      await sentCall(m, (b) => provider(b).set("a", "x").catch((error: unknown) => error)),
    ];
    for (const [name, input] of Object.entries(TOOL_INPUTS)) {
      outputs.push(
        await sentCall(m, (b) => {
          const tools: ToolSet = bilincTools({ bilinc: b, store: store() });
          const execute = tools[name]?.execute as (input: unknown, options: unknown) => Promise<unknown>;
          return execute(input, { toolCallId: "c", messages: [], context: {} });
        }),
      );
    }

    expect(outputs).toHaveLength(10);
    for (const request of m.sent) expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    for (const output of outputs) expect(texts(output)).not.toContain(KEY);
    expect(warn).toHaveBeenCalledTimes(10);
    for (const call of warn.mock.calls) expect(call.map(String).join(" ")).not.toContain(KEY);
  });

  it("the BilincError handed to onError carries no key in its message or stack", async () => {
    mockFetch(hostile[0] as Responder);
    const onError = vi.fn();
    await (createBilinc({ apiKey: KEY, onError }).memoryBlock().provider as BilincMemoryProvider).get();
    expect(onError).toHaveBeenCalledTimes(1);
    const [error] = onError.mock.calls[0] as [Error];
    expect(texts(error)).not.toContain(KEY);
  });
});
