import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModels } from "../src/client/api";

function mockFetch(handler: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => handler(url)));
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchModels", () => {
  it("reads the allowlist and validates it again", async () => {
    const entry = { id: "@cf/openai/gpt-oss-120b", label: "gpt-oss-120b", note: "", tag: "tested", effort: ["low", "medium", "high"] };
    mockFetch(() => new Response(JSON.stringify({ default: entry.id, models: [entry, { id: "nope" }] }), { status: 200 }));
    expect(await fetchModels()).toEqual({ defaultId: entry.id, models: [entry] });
  });

  it("gives null for a locked session, a body without a default, or no answer", async () => {
    mockFetch(() => new Response('{"error":"unauthorized"}', { status: 401 }));
    expect(await fetchModels()).toBeNull();
    mockFetch(() => new Response('{"state":"ok"}', { status: 200 }));
    expect(await fetchModels()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await fetchModels()).toBeNull();
  });
});
