// Secrets wiring and Wrangler config: what the Deploy button reads.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SIGNUP_URL } from "../src/constants";
import { parseModels } from "../src/models";

// Tests run from the template directory (npm test).
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const SECRETS = ["APP_ACCESS_TOKEN", "BILINC_API_KEY"];

describe("deploy configuration", () => {
  const wrangler = JSON.parse(read("wrangler.jsonc")) as Record<string, any>;
  const pkg = JSON.parse(read("package.json")) as Record<string, any>;

  it("wrangler.jsonc matches the spec", () => {
    expect(wrangler).toEqual({
      name: "bilinc-cloudflare-agent",
      main: "src/server.ts",
      compatibility_date: "2026-11-01",
      compatibility_flags: ["nodejs_compat"],
      ai: { binding: "AI" },
      durable_objects: {
        bindings: [
          { name: "BilincAgent", class_name: "BilincAgent" },
          { name: "UNLOCK_LIMITER", class_name: "UnlockLimiter" },
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["BilincAgent", "UnlockLimiter"] }],
      assets: { not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/agents/*"] },
      vars: { MODEL: "@cf/openai/gpt-oss-120b", MODELS: wrangler.vars.MODELS, BILINC_NAMESPACE: "default", AUTO_CHECKPOINT: "true" },
      secrets: { required: ["BILINC_API_KEY", "APP_ACCESS_TOKEN"] },
    });
  });

  it("names the same two secrets in .dev.vars.example, cloudflare.bindings and secrets.required", () => {
    const example = read(".dev.vars.example")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => line.split("=")[0]);
    expect([...example].sort()).toEqual(SECRETS);
    expect(Object.keys(pkg.cloudflare.bindings).sort()).toEqual(SECRETS);
    expect([...wrangler.secrets.required].sort()).toEqual(SECRETS);
  });

  it("explains each secret in the deploy prompt", () => {
    const key: string = pkg.cloudflare.bindings.BILINC_API_KEY.description;
    expect(key).toContain("free forever");
    expect(key).toContain("no card");
    expect(key).toContain("2,000 credits a month");
    expect(key).toContain("dedicated Bilinc account");
    expect(key).toContain(SIGNUP_URL);
    const token: string = pkg.cloudflare.bindings.APP_ACCESS_TOKEN.description;
    expect(token).toContain("at least 16 characters");
    expect(token).toContain("Anyone who knows it can use this agent and its Bilinc key");
  });

  it("has the build scripts the Deploy button and the release gate run", () => {
    expect(pkg.scripts).toMatchObject({
      dev: "vite dev",
      build: "vite build",
      deploy: "vite build && wrangler deploy",
      test: "vitest run",
      typecheck: "tsc --noEmit",
    });
  });

  it("keeps the dependency ranges from the spec", () => {
    expect(pkg.dependencies).toMatchObject({
      agents: "^0.34.0",
      "@cloudflare/think": "^0.24.0",
      "@cloudflare/computer": "^0.10.0",
      ai: "^7.0.0",
      zod: "^4.0.0",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
      "@ai-sdk/react": "^4.0.0",
    });
  });

  it("builds the model with createAI from agents/models/ai-sdk, not workers-ai-provider", () => {
    const agent = read("src/agent.ts");
    expect(agent).toContain('import { createAI, type AI } from "agents/models/ai-sdk";');
    expect(agent).not.toMatch(/from ["']workers-ai-provider/);
    expect(Object.keys(pkg.dependencies)).not.toContain("workers-ai-provider");
  });

  it("ships only the models verified on the createAI path, in the app and the test config", () => {
    const testWrangler = JSON.parse(read("test/wrangler.test.jsonc")) as Record<string, any>;
    const ids = (raw: unknown) => parseModels(raw, "@cf/openai/gpt-oss-120b").models.map((m) => m.id);
    expect(ids(wrangler.vars.MODELS)).toEqual(["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b"]);
    expect(ids(testWrangler.vars.MODELS)).toEqual(["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b"]);
  });

  it("lists MODEL first in MODELS, with every entry valid and no visible tag", () => {
    const testWrangler = JSON.parse(read("test/wrangler.test.jsonc")) as Record<string, any>;
    const raw = wrangler.vars.MODELS as unknown[];
    const config = parseModels(raw, wrangler.vars.MODEL);
    expect(Array.isArray(raw)).toBe(true);
    expect(config.models).toHaveLength(raw.length);
    expect(config.models[0]!.id).toBe(wrangler.vars.MODEL);
    // Tags are optional; the release gate decides whether a model gets one.
    for (const entry of [...raw, ...(testWrangler.vars.MODELS as unknown[])]) expect(entry).not.toHaveProperty("tag");
  });

  it("documents every model of MODELS, the notices and the disclaimer in the README", () => {
    const readme = read("README.md");
    for (const model of parseModels(wrangler.vars.MODELS, wrangler.vars.MODEL).models) expect(readme).toContain(`\`${model.id}\``);
    expect(readme).toContain("| `MODELS` |");
    expect(readme).toContain("[NOTICE](NOTICE)");
    expect(readme).toContain("Not affiliated with or endorsed by Cloudflare.");
  });
});
