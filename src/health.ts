import { DEFAULT_BASE_URL, HEALTH_TIMEOUT_MS, NAMESPACE_RE } from "./constants";
import { attempt } from "./transport";

export type BilincHealthState = "ok" | "key_missing" | "key_invalid" | "namespace_invalid" | "unreachable";

/** `https:` origin plus path without a trailing slash, or null. No credentials, query or fragment. */
export function httpsBaseUrl(raw: string = DEFAULT_BASE_URL): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * One-shot health probe for the template's GET /api/health. Never throws. Exactly one request at most:
 * no retry, no backoff, no breaker, no cap. The result never holds the key, a header or a body.
 */
export async function checkStatus(options: {
  apiKey: string | undefined;
  namespace?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<{ state: BilincHealthState; requestId?: string }> {
  try {
    if (options.namespace !== undefined && !NAMESPACE_RE.test(options.namespace)) return { state: "namespace_invalid" };
    const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
    if (!apiKey) return { state: "key_missing" };
    const baseUrl = httpsBaseUrl(options.baseUrl);
    if (!baseUrl) return { state: "unreachable" };

    const result = await attempt(baseUrl, apiKey, {
      method: "GET",
      path: "/status",
      timeoutMs: options.timeoutMs ?? HEALTH_TIMEOUT_MS,
    });
    const requestId = result.ok ? result.requestId : result.failure.requestId;
    let state: BilincHealthState = "unreachable";
    if (result.ok) state = "ok";
    else if (result.failure.kind === "json_error" && result.failure.code === "missing_api_key") state = "key_missing";
    else if (result.failure.kind === "json_error" && result.failure.code === "invalid_api_key") state = "key_invalid";
    return requestId ? { state, requestId } : { state };
  } catch {
    return { state: "unreachable" };
  }
}
