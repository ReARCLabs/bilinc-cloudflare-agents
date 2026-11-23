import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_URL_ERROR, NAMESPACE_ERROR, createBilinc } from "../src/create";
import { checkStatus } from "../src/health";
import { createMemoryBlock } from "../src/provider";
import * as pkg from "../src/index";
import { settle } from "./helpers/client";
import { mockFetch, ok, reject } from "./helpers/mock-fetch";

vi.mock("../src/provider", () => ({
  createMemoryBlock: vi.fn((_ctx: unknown, overrides?: { label?: string }) => ({ label: overrides?.label ?? "memory" })),
}));

const KEY = "bil_live_CREATEKEY_never_print_me";
const LIST_OK = ok({ entries: [], total: 0, nextCursor: null });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(createMemoryBlock).mockClear();
});

describe("createBilinc: validation", () => {
  it("pins the two error messages", () => {
    expect(NAMESPACE_ERROR).toBe("Bilinc namespace is invalid: use 1–64 letters, digits, `_` or `-`");
    expect(BASE_URL_ERROR).toBe("Bilinc baseUrl must be an https URL");
  });

  it.each(["", "x".repeat(65), "bad.name", "space here", "ümlaut"])("namespace %j throws the namespace message", (namespace) => {
    expect(() => createBilinc({ apiKey: KEY, namespace })).toThrow(new Error(NAMESPACE_ERROR));
  });

  it.each([
    [undefined, "cf.default."],
    ["team_a", "cf.team_a."],
    ["A-1", "cf.A-1."],
    ["x".repeat(64), `cf.${"x".repeat(64)}.`],
  ])("namespace %j gives prefix %j", (namespace, prefix) => {
    expect(createBilinc({ apiKey: KEY, ...(namespace !== undefined ? { namespace } : {}) }).prefix).toBe(prefix);
  });

  it.each(["http://bilinc.space", "ftp://bilinc.space", "not a url", "https://u:p@bilinc.space", "https://bilinc.space/?a=1"])(
    "baseUrl %j throws the baseUrl message",
    (baseUrl) => {
      expect(() => createBilinc({ apiKey: KEY, baseUrl })).toThrow(new Error(BASE_URL_ERROR));
    },
  );

  it("an empty apiKey does not throw", () => {
    expect(() => createBilinc({ apiKey: "" })).not.toThrow();
  });

  it("the thrown messages never contain the key", () => {
    for (const options of [{ namespace: "bad.name" }, { baseUrl: "http://x" }]) {
      try {
        createBilinc({ apiKey: KEY, ...options });
      } catch (error) {
        expect(String(error)).not.toContain(KEY);
      }
    }
  });
});

describe("createBilinc: wiring", () => {
  it("sends to the given https base without a trailing slash", async () => {
    const m = mockFetch(LIST_OK);
    await createBilinc({ apiKey: ` ${KEY} `, baseUrl: "https://staging.example.com/base/" }).client.list();
    expect(m.sent[0]?.url).toBe("https://staging.example.com/base/api/cloud/memory/list");
    expect(m.sent[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("memoryBlock() hands the provider this instance's client and settings", () => {
    const bilinc = createBilinc({
      apiKey: KEY,
      namespace: "team_a",
      agentId: "agent-1",
      sessionId: "chat-1",
      profile: "fast",
      limit: 7,
      maxChars: 3000,
    });
    const block = bilinc.memoryBlock({ label: "facts" });
    expect(block).toEqual({ label: "facts" });
    expect(vi.mocked(createMemoryBlock)).toHaveBeenCalledExactlyOnceWith(
      {
        client: bilinc.client,
        prefix: "cf.team_a.",
        namespace: "team_a",
        agentId: "agent-1",
        sessionId: "chat-1",
        profile: "fast",
        limit: 7,
        maxChars: 3000,
      },
      { label: "facts" },
    );
  });

  it.each([
    [undefined, 5],
    [0, 1],
    [-3, 1],
    [7.9, 7],
    [25, 25],
    [100, 25],
    [Number.NaN, 5],
  ])("limit %j is used as %j", (limit, expected) => {
    createBilinc({ apiKey: KEY, ...(limit !== undefined ? { limit } : {}) }).memoryBlock();
    expect(vi.mocked(createMemoryBlock).mock.calls[0]?.[0]).toMatchObject({ limit: expected });
  });

  it("defaults: profile balanced, maxChars 6000, no agentId or sessionId", () => {
    createBilinc({ apiKey: KEY, maxChars: 0 }).memoryBlock();
    expect(vi.mocked(createMemoryBlock).mock.calls[0]?.[0]).toEqual({
      client: expect.anything(),
      prefix: "cf.default.",
      namespace: "default",
      profile: "balanced",
      limit: 5,
      maxChars: 6000,
    });
  });
});

describe("createBilinc: one breaker per instance", () => {
  it("three failed reads open this instance only; another instance still sends", async () => {
    const m = mockFetch(reject);
    const a = createBilinc({ apiKey: KEY, onError: () => {} });
    const b = createBilinc({ apiKey: KEY, onError: () => {} });
    for (let i = 0; i < 3; i++) {
      const p = settle(a.client.list());
      await vi.advanceTimersByTimeAsync(1000);
      await p;
    }
    expect(m.fn).toHaveBeenCalledTimes(9);
    const blocked = await settle(a.client.list());
    expect(blocked.ok === false && (blocked.error as { code: string }).code).toBe("circuit_open");
    expect(m.fn).toHaveBeenCalledTimes(9);

    mockFetch(LIST_OK);
    expect((await settle(b.client.list())).ok).toBe(true);
  });

  it("ten failing checkStatus() calls leave an existing instance's breaker closed", async () => {
    const bilinc = createBilinc({ apiKey: KEY });
    mockFetch(reject);
    for (let i = 0; i < 10; i++) expect((await checkStatus({ apiKey: KEY })).state).toBe("unreachable");
    const m = mockFetch(LIST_OK);
    expect((await settle(bilinc.client.list())).ok).toBe(true);
    expect(m.fn).toHaveBeenCalledTimes(1);
  });
});

describe("createBilinc: onError", () => {
  it("defaults to one console.warn line with op, code and requestId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(ok({ snapshots: {} }));
    await settle(createBilinc({ apiKey: KEY }).client.listSnapshots());
    expect(warn.mock.calls).toEqual([["[bilinc] listSnapshots failed: bad_response requestId=req_ok"]]);
  });

  it("calls a custom onError with the op", async () => {
    const onError = vi.fn();
    mockFetch(ok({ snapshots: {} }));
    await settle(createBilinc({ apiKey: KEY, onError }).client.listSnapshots());
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "bad_response" }), "listSnapshots");
  });
});

describe("entry PKG", () => {
  it("exports exactly the public runtime names", () => {
    expect(Object.keys(pkg).sort()).toEqual(["BilincError", "checkStatus", "createBilinc", "isBilincError", "noticeFor"]);
  });
});
