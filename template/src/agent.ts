import { Think, type ThinkModel, type ThinkModelId, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { ContextConfig } from "agents/context";
import type { ToolSet } from "ai";
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

export function stripWorkspaceLine(system: string): string {
  return system
    .split("\n")
    .filter((line) => line !== WORKSPACE_CAPABILITY_LINE)
    .join("\n");
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

  override getModel(): ThinkModel {
    return this.env.MODEL as ThinkModelId;
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
    if (this.env.AUTO_CHECKPOINT === "false") return;
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
      await this.ctx.storage.put(AUTO_CHECKPOINT_FLAG, "done" satisfies AutoCheckpointFlag);
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
    }
  }
}
