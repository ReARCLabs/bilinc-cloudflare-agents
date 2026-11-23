import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Every outbound fetch() of the test Worker lands here, in Node, instead of the network.
 * The answer echoes what workerd really sent, so the test can assert the init that survived.
 */
async function bilincOrigin(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/cloud/redirect") {
    return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } });
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = request.method === "POST" ? await request.text() : "";
  return Response.json({
    status: "ok",
    echo: { method: request.method, path: url.pathname + url.search, headers, body },
    _meta: { requestId: "req_workerd" },
  });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/workers/wrangler.jsonc" },
      miniflare: { outboundService: bilincOrigin },
      remoteBindings: false,
    }),
  ],
  test: {
    include: ["test/workers/**/*.test.ts"],
  },
});
