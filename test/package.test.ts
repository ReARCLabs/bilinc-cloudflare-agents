import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";

const root = new URL("../", import.meta.url);

describe("package.json", () => {
  it("is the unscoped, ESM-only package with two entries", () => {
    expect(pkg.name).toBe("bilinc-cloudflare-agents");
    expect(pkg.type).toBe("module");
    expect(pkg).not.toHaveProperty("main");
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./tools": { types: "./dist/tools.d.ts", import: "./dist/tools.js" },
      "./package.json": "./package.json",
    });
    expect(JSON.stringify(pkg.exports)).not.toContain("require");
    expect(pkg.homepage).toBe("https://bilinc.space/?utm_source=npm&utm_medium=package&utm_campaign=bilinc-cloudflare-agents");
  });

  it("has peers as ranges and no runtime dependencies", () => {
    expect(pkg.peerDependencies).toEqual({ agents: ">=0.34.0 <1", ai: "^7.0.0", zod: "^4.0.0" });
    expect(pkg).not.toHaveProperty("dependencies");
  });

  it("uses vitest 4.1, the range @cloudflare/vitest-pool-workers peers", () => {
    expect(pkg.devDependencies.vitest).toBe("^4.1.0");
    expect(pkg.devDependencies["@cloudflare/vitest-pool-workers"]).toBe("0.23.0");
  });

  it("publishes dist, README and LICENSE under MIT for ReARC Labs Inc.", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(pkg.license).toBe("MIT");
    expect(pkg.author).toBe("ReARC Labs Inc.");
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.keywords).toEqual(["cloudflare-agents", "think", "context-provider", "agent-memory", "bilinc"]);
    expect(existsSync(new URL("LICENSE", root))).toBe(true);
    const license = readFileSync(new URL("LICENSE", root), "utf8");
    expect(license.startsWith("MIT License\n\nCopyright (c) 2026 ReARC Labs Inc.\n")).toBe(true);
  });
});
