import { DurableObject } from "cloudflare:workers";
import { UNLOCK_MAX_FAILURES, UNLOCK_WINDOW_MS } from "./constants";

export interface UnlockVerdict {
  blocked: boolean;
  retryAfterSeconds: number;
}

/** attempt()'s answer: `slot` is the timestamp it reserved, or null when it answered blocked. */
export interface UnlockAttempt extends UnlockVerdict {
  slot: number | null;
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
   * same IP can never read the same count. A successful unlock then calls release() with the slot
   * returned here, which frees that slot only.
   */
  async attempt(): Promise<UnlockAttempt> {
    const now = Date.now();
    const recent = this.recentFailures(now);
    const current = verdict(recent, now);
    if (current.blocked) return { ...current, slot: null };
    this.ctx.storage.kv.put(FAILURES_KEY, [...recent, now]);
    await this.ctx.storage.setAlarm(now + UNLOCK_WINDOW_MS);
    return { ...current, slot: now };
  }

  /**
   * Frees the one slot attempt() reserved for an unlock that succeeded. Other failures stay
   * counted, because the bucket may be shared (an IPv4 NAT, an IPv6 /64). Parallel attempts can
   * share a timestamp, so exactly one matching entry is removed. Synchronous KV again, no await
   * between the read and the write.
   */
  async release(slot: number): Promise<void> {
    const stored = this.ctx.storage.kv.get<number[]>(FAILURES_KEY) ?? [];
    const index = stored.indexOf(slot);
    if (index === -1) return;
    const rest = [...stored.slice(0, index), ...stored.slice(index + 1)];
    if (rest.length > 0) {
      this.ctx.storage.kv.put(FAILURES_KEY, rest);
      return;
    }
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
