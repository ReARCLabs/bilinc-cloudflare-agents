import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Serves only the fixture page; no Worker, no Cloudflare plugin, no network.
const here = fileURLToPath(new URL(".", import.meta.url));
const template = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 4178, strictPort: true, fs: { allow: [template] } },
});
