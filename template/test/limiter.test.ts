import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { UNLOCK_WINDOW_MS } from "../src/constants";

const e = env as unknown as Env;
const limiterFor = (ip: string) => e.UNLOCK_LIMITER.get(e.UNLOCK_LIMITER.idFromName(ip));

describe("UnlockLimiter", () => {
  it("allows 5 attempts inside the window and blocks the 6th without counting it", async () => {
    const limiter = limiterFor(crypto.randomUUID());
    for (let i = 0; i < 5; i++) expect(await limiter.attempt()).toMatchObject({ blocked: false, retryAfterSeconds: 0, slot: expect.any(Number) });
    const sixth = await limiter.attempt();
    expect(sixth.blocked).toBe(true);
    expect(sixth.slot).toBeNull();
    expect(sixth.retryAfterSeconds).toBeGreaterThan(590);
    expect(await limiter.check()).toMatchObject({ blocked: true });
    expect(await runInDurableObject(limiter, (_i, state) => state.storage.get<number[]>("failures"))).toHaveLength(5);
  });

  it("reserves a slot for each of many parallel attempts, so at most 5 are allowed", async () => {
    const limiter = limiterFor(crypto.randomUUID());
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => limiter.attempt()));
    expect(verdicts.filter((v) => !v.blocked)).toHaveLength(5);
    expect(await runInDurableObject(limiter, (_i, state) => state.storage.get<number[]>("failures"))).toHaveLength(5);
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

  it("release(slot) frees only the slot that attempt() reserved", async () => {
    const limiter = limiterFor(crypto.randomUUID());
    for (let i = 0; i < 4; i++) await limiter.attempt();
    const fifth = await limiter.attempt();
    expect(await limiter.check()).toMatchObject({ blocked: true });
    await limiter.release(fifth.slot!);
    expect(await runInDurableObject(limiter, (_i, state) => state.storage.get<number[]>("failures"))).toHaveLength(4);
    expect(await limiter.check()).toEqual({ blocked: false, retryAfterSeconds: 0 });
    expect((await limiter.attempt()).blocked).toBe(false);
    expect((await limiter.attempt()).blocked).toBe(true);
  });

  it("release(slot) removes one entry when parallel attempts share a timestamp, and nothing for an unknown slot", async () => {
    const stub = limiterFor(crypto.randomUUID());
    const t = Date.now() - 1_000;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("failures", [t, t, t]);
    });
    await stub.release(t);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get<number[]>("failures"))).toEqual([t, t]);
    await stub.release(t - 1);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get<number[]>("failures"))).toEqual([t, t]);
  });

  it("release(slot) of the only failure deletes the counter and its alarm", async () => {
    const stub = limiterFor(crypto.randomUUID());
    const { slot } = await stub.attempt();
    await stub.release(slot!);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("failures"))).toBeUndefined();
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });

  it("schedules an alarm that deletes the counter", async () => {
    const stub = limiterFor(crypto.randomUUID());
    for (let i = 0; i < 5; i++) await stub.attempt();
    const alarmAt = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarmAt).toBeGreaterThan(Date.now() + UNLOCK_WINDOW_MS - 5_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("failures"))).toBeUndefined();
    expect(await stub.check()).toEqual({ blocked: false, retryAfterSeconds: 0 });
  });
});
