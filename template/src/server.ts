import { routeAgentRequest } from "agents";
import { checkStatus } from "bilinc-cloudflare-agents";
import { readCheckpoints } from "./checkpoints";
import { AGENT_PATH } from "./constants";
import { accessToken, handleUnlock, isTokenLongEnough, jsonResponse, verifySessionCookie } from "./gate";
import { parseModels } from "./models";

export { BilincAgent } from "./agent";
export { UnlockLimiter } from "./limiter";

const notFound = () => jsonResponse(404, { error: "not_found" });

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const isApi = pathname.startsWith("/api/");
  const isAgents = pathname.startsWith("/agents/");
  if (!isApi && !isAgents) return notFound();

  const token = accessToken(env);
  if (!isTokenLongEnough(token)) {
    return jsonResponse(503, { error: "access_token_too_short" });
  }

  if (pathname === "/api/unlock") {
    if (request.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" }, { Allow: "POST" });
    return handleUnlock(request, env);
  }

  if (!(await verifySessionCookie(request.headers.get("Cookie"), token))) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  if (isApi) {
    if (pathname === "/api/health" && request.method === "GET") {
      const { state } = await checkStatus({ apiKey: env.BILINC_API_KEY, namespace: env.BILINC_NAMESPACE });
      return jsonResponse(200, { state });
    }
    if (pathname === "/api/models" && request.method === "GET") {
      const { defaultId, models } = parseModels(env.MODELS, env.MODEL);
      return jsonResponse(200, { default: defaultId, models });
    }
    if (pathname === "/api/checkpoints" && request.method === "GET") {
      return jsonResponse(200, await readCheckpoints(env));
    }
    return notFound();
  }

  if (!AGENT_PATH.test(pathname)) return notFound();
  return (await routeAgentRequest(request, env)) ?? notFound();
}

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
