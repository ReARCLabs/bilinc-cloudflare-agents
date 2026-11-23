// Test entry for test/wrangler.test.jsonc. Task 12 replaces TestAgent with the scripted-model version.
import { BilincAgent } from "../../src/agent";

export { UnlockLimiter } from "../../src/limiter";
export { default } from "../../src/server";

export class TestAgent extends BilincAgent {}
