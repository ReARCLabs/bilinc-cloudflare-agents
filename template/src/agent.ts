import { Think, type ThinkModel, type ThinkModelId } from "@cloudflare/think";

// Stub so the Worker builds; Task 12 replaces it.
export class BilincAgent extends Think<Env> {
  override getModel(): ThinkModel {
    return this.env.MODEL as ThinkModelId;
  }
}
