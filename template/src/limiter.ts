import { DurableObject } from "cloudflare:workers";
import { UNLOCK_MAX_FAILURES, UNLOCK_WINDOW_MS } from "./constants";

export interface UnlockVerdict {
  blocked: boolean;
  retryAfterSeconds: number;
}

const FAILURES_KEY = "failures";

export class UnlockLimiter extends DurableObject<Env> {
  async check(): Promise<UnlockVerdict> {
    const now = Date.now();
    return verdict(await this.recentFailures(now), now);
  }

  async recordFailure(): Promise<UnlockVerdict> {
    const now = Date.now();
    const failures = [...(await this.recentFailures(now)), now];
    await this.ctx.storage.put(FAILURES_KEY, failures);
    await this.ctx.storage.setAlarm(now + UNLOCK_WINDOW_MS);
    return verdict(failures, now);
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async recentFailures(now: number): Promise<number[]> {
    const stored = (await this.ctx.storage.get<number[]>(FAILURES_KEY)) ?? [];
    return stored.filter((t) => now - t < UNLOCK_WINDOW_MS).sort((a, b) => a - b);
  }
}

function verdict(failures: number[], now: number): UnlockVerdict {
  if (failures.length < UNLOCK_MAX_FAILURES) return { blocked: false, retryAfterSeconds: 0 };
  const oldestOfLastFive = failures[failures.length - UNLOCK_MAX_FAILURES]!;
  const waitMs = oldestOfLastFive + UNLOCK_WINDOW_MS - now;
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
}
