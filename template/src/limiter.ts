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
    return verdict(this.recentFailures(now), now);
  }

  /**
   * Reserves one failure slot before the passphrase is compared, or answers blocked. The read and
   * the write use the synchronous KV API with no await between them, so parallel attempts from the
   * same IP can never read the same count. A successful unlock then calls clear(), which releases
   * the slot.
   */
  async attempt(): Promise<UnlockVerdict> {
    const now = Date.now();
    const recent = this.recentFailures(now);
    const current = verdict(recent, now);
    if (current.blocked) return current;
    this.ctx.storage.kv.put(FAILURES_KEY, [...recent, now]);
    await this.ctx.storage.setAlarm(now + UNLOCK_WINDOW_MS);
    return current;
  }

  async clear(): Promise<void> {
    this.ctx.storage.kv.delete(FAILURES_KEY);
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private recentFailures(now: number): number[] {
    const stored = this.ctx.storage.kv.get<number[]>(FAILURES_KEY) ?? [];
    return stored.filter((t) => now - t < UNLOCK_WINDOW_MS).sort((a, b) => a - b);
  }
}

function verdict(failures: number[], now: number): UnlockVerdict {
  if (failures.length < UNLOCK_MAX_FAILURES) return { blocked: false, retryAfterSeconds: 0 };
  const oldestOfLastFive = failures[failures.length - UNLOCK_MAX_FAILURES]!;
  const waitMs = oldestOfLastFive + UNLOCK_WINDOW_MS - now;
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
}
