import { routeAgentRequest } from "agents";
import { checkStatus } from "bilinc-cloudflare-agents";
import { AGENT_PATH } from "./constants";
import { handleUnlock, isTokenLongEnough, jsonResponse, verifySessionCookie } from "./gate";

export { BilincAgent } from "./agent";
export { UnlockLimiter } from "./limiter";

const notFound = () => jsonResponse(404, { error: "not_found" });

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const isApi = pathname.startsWith("/api/");
  const isAgents = pathname.startsWith("/agents/");
  if (!isApi && !isAgents) return notFound();

  if (!isTokenLongEnough(env.APP_ACCESS_TOKEN)) {
    return jsonResponse(503, { error: "access_token_too_short" });
  }

  if (pathname === "/api/unlock") {
    if (request.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" }, { Allow: "POST" });
    return handleUnlock(request, env);
  }

  if (!(await verifySessionCookie(request.headers.get("Cookie"), env.APP_ACCESS_TOKEN))) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  if (isApi) {
    if (pathname === "/api/health" && request.method === "GET") {
      const { state } = await checkStatus({ apiKey: env.BILINC_API_KEY, namespace: env.BILINC_NAMESPACE });
      return jsonResponse(200, { state });
    }
    return notFound();
  }

  if (!AGENT_PATH.test(pathname)) return notFound();
  return (await routeAgentRequest(request, env)) ?? notFound();
}

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
