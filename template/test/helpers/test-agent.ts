// Test entry for test/wrangler.test.jsonc: the binding "BilincAgent" runs TestAgent, which
// swaps in the scripted model and lets a test overlay env vars before a Durable Object starts.
import type { TurnConfig, TurnContext } from "@cloudflare/think";
import type { LanguageModel } from "ai";
import { BilincAgent } from "../../src/agent";
import { currentModel } from "./mock-model";

export { UnlockLimiter } from "../../src/limiter";
export { default } from "../../src/server";

interface RecordedTurn {
  name: string;
  system: string;
  continuation: boolean;
  activeTools?: string[];
}
interface TestGlobals {
  __bilincTestEnv?: Partial<Env>;
  __bilincTurns?: RecordedTurn[];
}
const g = globalThis as unknown as TestGlobals;

/** Overlay applied to env by every TestAgent constructed after this call. */
export function setAgentEnv(overrides: Partial<Env> | undefined): void {
  g.__bilincTestEnv = overrides;
}

export function recordedTurns(): RecordedTurn[] {
  return (g.__bilincTurns ??= []);
}

export class TestAgent extends BilincAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, ...(g.__bilincTestEnv ?? {}) } as Env);
  }

  override getModel(): LanguageModel {
    return currentModel();
  }

  /** Public wrapper so tests can run a continuation turn (continueLastTurn is protected). */
  continueTurn(): Promise<unknown> {
    return this.continueLastTurn();
  }

  override beforeTurn(ctx: TurnContext): TurnConfig {
    const config = super.beforeTurn(ctx);
    recordedTurns().push({ name: this.name, system: ctx.system, continuation: ctx.continuation, activeTools: config.activeTools });
    return config;
  }
}
