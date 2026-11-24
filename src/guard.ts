import { BREAKER_OPEN_MS, BREAKER_THRESHOLD, RATE_CAP, RATE_WINDOW_MS } from "./constants";
import type { BreakerEffect } from "./transport";

/**
 * Circuit breaker and rate cap of one createBilinc() instance. In memory only.
 * The breaker keeps one number (consecutive failures) and has no half-open state.
 */
export class Guard {
  private failures = 0;
  private openUntil = 0;
  private billable: number[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Called once per logical call, after validation and before anything is sent. */
  admit(billable: boolean): "circuit_open" | "rate_capped" | null {
    const t = this.now();
    if (this.openUntil !== 0) {
      if (t < this.openUntil) return "circuit_open";
      this.openUntil = 0;
      this.failures = 0;
    }
    if (billable) {
      this.billable = this.billable.filter((at) => at > t - RATE_WINDOW_MS);
      if (this.billable.length >= RATE_CAP) return "rate_capped";
      this.billable.push(t);
    }
    return null;
  }

  /** Called once per logical call with the effect of its final outcome. */
  record(effect: BreakerEffect): void {
    const t = this.now();
    const open = this.openUntil !== 0 && t < this.openUntil;
    switch (effect.kind) {
      case "open":
        this.openUntil = Math.max(this.openUntil, t + effect.openMs);
        this.failures = 0;
        return;
      case "count":
        if (open) return;
        this.failures += 1;
        if (this.failures >= BREAKER_THRESHOLD) {
          this.openUntil = t + BREAKER_OPEN_MS;
          this.failures = 0;
        }
        return;
      case "reset":
        if (!open) this.failures = 0;
        return;
      case "none":
        return;
    }
  }

  /** For tests and logs, and for the tools' check before a prompt refresh (see BREAKER_OPEN). */
  state(): { failures: number; open: boolean; openUntil: number } {
    const t = this.now();
    return { failures: this.failures, open: this.openUntil !== 0 && t < this.openUntil, openUntil: this.openUntil };
  }
}
