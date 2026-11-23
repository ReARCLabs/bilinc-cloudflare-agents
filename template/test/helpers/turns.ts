import type { UIMessage } from "ai";

export function userMessage(text: string): UIMessage {
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
}

/** Poll `read` until it returns a value accepted by `done`, or fail after `timeoutMs`. */
export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function toolParts(messages: UIMessage[], toolName: string): { state: string; input?: unknown; output?: unknown; errorText?: string }[] {
  return messages.flatMap((m) => m.parts).filter((p) => p.type === `tool-${toolName}`) as never;
}
