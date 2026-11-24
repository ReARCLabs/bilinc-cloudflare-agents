import { Think, type ThinkModel, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { ContextConfig } from "agents/context";
import { createAI, type AI } from "agents/models/ai-sdk";
import type { LanguageModel, ToolSet } from "ai";
import { createBilinc, isBilincError, type Bilinc } from "bilinc-cloudflare-agents";
import { bilincTools } from "bilinc-cloudflare-agents/tools";
import {
  ACTIVE_TOOLS,
  AUTO_CHECKPOINT_FLAG,
  AUTO_CHECKPOINT_LABEL_PREFIX,
  SYSTEM_INSTRUCTIONS,
  WORKSPACE_CAPABILITY_LINE,
  type AutoCheckpointFlag,
} from "./constants";
import type { ModelChoice } from "./models";

export function stripWorkspaceLine(system: string): string {
  return system
    .split("\n")
    .filter((line) => line !== WORKSPACE_CAPABILITY_LINE)
    .join("\n");
}

const AUTO_CHECKPOINT_OFF = new Set(["false", "0", "off", "no"]);

/**
 * AUTO_CHECKPOINT is off for "false", "0", "off" or "no", in any case and with spaces at either end,
 * and on for anything else, unset included. A JSON false or 0 in wrangler vars counts as off too.
 */
export function autoCheckpointEnabled(value: unknown): boolean {
  return !AUTO_CHECKPOINT_OFF.has(String(value ?? "").trim().toLowerCase());
}

export class BilincAgent extends Think<Env> {
  private _bilinc?: Bilinc;

  // One instance per Durable Object: the memory block and the tools share its breaker and rate cap.
  private get bilinc(): Bilinc {
    return (this._bilinc ??= createBilinc({
      apiKey: this.env.BILINC_API_KEY,
      namespace: this.env.BILINC_NAMESPACE,
      sessionId: this.name,
    }));
  }

  private _ai?: AI;

  /**
   * The only place a model is built: createAI from agents/models/ai-sdk, which replaces the
   * deprecated workers-ai-provider for this agent. Session affinity matches what Think's own
   * resolver sends. Reasoning effort is sent only when the choice has one: null would mean
   * "reasoning off", which @cf/openai models do not support. Tests override this method.
   */
  protected languageModel(choice: ModelChoice): LanguageModel {
    const ai = (this._ai ??= createAI({ binding: this.env.AI }));
    return ai.languageModel(choice.model, {
      sessionAffinity: this.sessionAffinity,
      ...(choice.effort ? { reasoningEffort: choice.effort } : {}),
    });
  }

  override getModel(): ThinkModel {
    return this.languageModel({ model: this.env.MODEL, effort: null });
  }

  override getSystemPrompt(): string {
    return SYSTEM_INSTRUCTIONS;
  }

  override configureContext(): ContextConfig[] {
    return [this.bilinc.memoryBlock()];
  }

  override getTools(): ToolSet {
    return bilincTools({
      bilinc: this.bilinc,
      store: this.ctx.storage,
      onMemoryChanged: () => this.context.refreshSystemPrompt(),
    });
  }

  override beforeTurn(ctx: TurnContext): TurnConfig {
    return { activeTools: [...ACTIVE_TOOLS], instructions: stripWorkspaceLine(ctx.system) };
  }

  // A prototype method, never an arrow field: Think binds this.onStart in its constructor.
  override async onStart(): Promise<void> {
    if (!autoCheckpointEnabled(this.env.AUTO_CHECKPOINT)) return;
    const flag = await this.ctx.storage.get<AutoCheckpointFlag>(AUTO_CHECKPOINT_FLAG);
    if (flag === undefined) {
      await this.ctx.storage.put(AUTO_CHECKPOINT_FLAG, "pending" satisfies AutoCheckpointFlag);
      this.ctx.waitUntil(this.runAutoCheckpoint());
      return;
    }
    if (flag === "pending") {
      await this.ctx.storage.put(AUTO_CHECKPOINT_FLAG, "unknown" satisfies AutoCheckpointFlag);
    }
  }

  async runAutoCheckpoint(): Promise<void> {
    try {
      await this.bilinc.client.createSnapshot({ label: AUTO_CHECKPOINT_LABEL_PREFIX + new Date().toISOString() });
    } catch (error) {
      try {
        if (isBilincError(error) && error.outcomeUnknown) {
          await this.ctx.storage.put(AUTO_CHECKPOINT_FLAG, "unknown" satisfies AutoCheckpointFlag);
        } else {
          await this.ctx.storage.delete(AUTO_CHECKPOINT_FLAG);
          if (!isBilincError(error)) console.warn("[bilinc] automatic checkpoint skipped: agent setup failed");
        }
      } catch {
        // Storage failed too; the next wake decides from whatever flag is stored.
      }
      return;
    }
    // The checkpoint exists from here on, so the flag is never deleted: that would make the next wake
    // create a second one. Try the write twice; if both fail the flag stays "pending", which the next
    // wake turns into "unknown" without sending anything.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ctx.storage.put(AUTO_CHECKPOINT_FLAG, "done" satisfies AutoCheckpointFlag);
        return;
      } catch {
        // Retried once below.
      }
    }
    console.warn(
      "[bilinc] automatic checkpoint created, but its flag could not be stored as done; the next wake marks it unknown and creates no second one",
    );
  }
}
