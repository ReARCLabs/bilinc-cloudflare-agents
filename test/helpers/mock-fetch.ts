import { vi } from "vitest";

export type Responder = (request: Request) => Response | Promise<Response>;

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestRedirect;
  hasSignal: boolean;
}

export interface MockFetch {
  /** Every request fetch was called with, in order. */
  sent: SentRequest[];
  fn: ReturnType<typeof vi.fn>;
}

/**
 * Installs a scripted global fetch. Responder i answers call i; the last responder answers every
 * later call. Call vi.unstubAllGlobals() in afterEach.
 */
export function mockFetch(...responders: Responder[]): MockFetch {
  const sent: SentRequest[] = [];
  const fn = vi.fn(async (input: Request) => {
    const index = Math.min(sent.length, responders.length - 1);
    const text = input.method === "POST" ? await input.clone().text() : "";
    const headers: Record<string, string> = {};
    input.headers.forEach((value, name) => {
      headers[name] = value;
    });
    sent.push({
      method: input.method,
      url: input.url,
      headers,
      body: text ? JSON.parse(text) : undefined,
      redirect: input.redirect,
      hasSignal: input.signal instanceof AbortSignal,
    });
    const responder = responders[index];
    if (!responder) throw new Error("mockFetch: no responder");
    return responder(input);
  });
  vi.stubGlobal("fetch", fn);
  return { sent, fn };
}

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Responder =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export const ok = (body: Record<string, unknown>, status = 200): Responder =>
  json(status, { ...body, _meta: { requestId: "req_ok", apiVersion: "2026-10-01" } });

export const apiError = (status: number, code: string, details?: Record<string, unknown>): Responder =>
  json(status, {
    error: code,
    message: "server text that must never reach the model",
    requestId: "req_err",
    retryable: status >= 500,
    ...(details ? { details } : {}),
  });

export const html =
  (status: number, headers: Record<string, string> = {}): Responder =>
  () =>
    new Response("<html><body>edge page</body></html>", { status, headers: { "Content-Type": "text/html", ...headers } });

export const redirect =
  (status = 302): Responder =>
  () =>
    new Response(null, { status, headers: { Location: "https://elsewhere.example/" } });

export const reject: Responder = () => Promise.reject(new TypeError("fetch failed"));

/** Never answers; rejects when the request's signal aborts (the client timeout). */
export const hang: Responder = (request) =>
  new Promise<Response>((_resolve, rejectPromise) => {
    request.signal.addEventListener("abort", () => rejectPromise(new DOMException("aborted", "AbortError")));
  });
