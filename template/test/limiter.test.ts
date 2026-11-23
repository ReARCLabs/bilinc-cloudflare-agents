import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { UNLOCK_WINDOW_MS } from "../src/constants";

const e = env as unknown as Env;
const limiterFor = (ip: string) => e.UNLOCK_LIMITER.get(e.UNLOCK_LIMITER.idFromName(ip));

describe("UnlockLimiter", () => {
  it("blocks at 5 failures inside the window", async () => {
    const limiter = limiterFor(crypto.randomUUID());
    for (let i = 0; i < 4; i++) expect((await limiter.recordFailure()).blocked).toBe(false);
    const fifth = await limiter.recordFailure();
    expect(fifth.blocked).toBe(true);
    expect(fifth.retryAfterSeconds).toBeGreaterThan(590);
    expect(await limiter.check()).toMatchObject({ blocked: true });
  });

  it("ends the block when the oldest of the five is 10 minutes old", async () => {
    const stub = limiterFor(crypto.randomUUID());
    const now = Date.now();
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("failures", [now - UNLOCK_WINDOW_MS + 2_000, now - 4_000, now - 3_000, now - 2_000, now - 1_000]);
    });
    const blocked = await stub.check();
    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(2);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("failures", [now - UNLOCK_WINDOW_MS - 1, now - 4_000, now - 3_000, now - 2_000, now - 1_000]);
    });
    expect(await stub.check()).toEqual({ blocked: false, retryAfterSeconds: 0 });
  });

  it("clear() forgets the failures", async () => {
    const limiter = limiterFor(crypto.randomUUID());
    for (let i = 0; i < 5; i++) await limiter.recordFailure();
    await limiter.clear();
    expect(await limiter.check()).toEqual({ blocked: false, retryAfterSeconds: 0 });
  });

  it("schedules an alarm that deletes the counter", async () => {
    const stub = limiterFor(crypto.randomUUID());
    for (let i = 0; i < 5; i++) await stub.recordFailure();
    const alarmAt = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarmAt).toBeGreaterThan(Date.now() + UNLOCK_WINDOW_MS - 5_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("failures"))).toBeUndefined();
    expect(await stub.check()).toEqual({ blocked: false, retryAfterSeconds: 0 });
  });
});
