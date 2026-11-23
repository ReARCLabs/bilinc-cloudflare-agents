import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const DOM_TESTS = ["test/chat-id.test.ts", "test/config.test.ts", "test/**/*.test.tsx"];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.test.jsonc" }, remoteBindings: false })],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          exclude: ["**/node_modules/**", ...DOM_TESTS],
          testTimeout: 20_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: DOM_TESTS,
          // Node 25+ defines its own localStorage global, which hides jsdom's; turn it off here.
          execArgv: ["--no-experimental-webstorage"],
        },
      },
    ],
  },
});
