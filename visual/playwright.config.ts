import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const template = fileURLToPath(new URL("../template", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4178" },
  webServer: {
    command: "npx vite --config test/visual/vite.config.ts",
    cwd: template,
    url: "http://127.0.0.1:4178/fixtures.html",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
