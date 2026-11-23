import { vi } from "vitest";
import { createClient } from "../../src/client";
import type { BilincClient } from "../../src/client";
import type { BilincError, BilincOp } from "../../src/errors";
import { Guard } from "../../src/guard";

export const BASE = "https://bilinc.space";
export const KEY = "bil_live_TESTKEY_never_print_me";

export function makeClient(guard: Guard = new Guard()): {
  client: BilincClient;
  guard: Guard;
  onError: ReturnType<typeof vi.fn<(error: BilincError, op: BilincOp) => void>>;
} {
  const onError = vi.fn<(error: BilincError, op: BilincOp) => void>();
  return { client: createClient({ apiKey: KEY, baseUrl: BASE, guard, onError }), guard, onError };
}

/** Never leaves a rejected promise unhandled. */
export function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
