import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTICES, isBilincError, noticeFor } from "../src/errors";
import type { BilincError } from "../src/errors";
import { makeClient, settle } from "./helpers/client";
import { json, mockFetch, ok } from "./helpers/mock-fetch";
import commitFixture from "./fixtures/commit.json";
import diffFixture from "./fixtures/diff.json";
import historyFixture from "./fixtures/history.json";
import listFixture from "./fixtures/list.json";
import recallFixture from "./fixtures/recall.json";
import previewFixture from "./fixtures/rollback-preview.json";
import snapshotsFixture from "./fixtures/snapshots.json";
import statusFixture from "./fixtures/status.json";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const API = "https://bilinc.space/api/cloud";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rejection(p: Promise<unknown>): Promise<BilincError> {
  const r = await settle(p);
  if (r.ok || !isBilincError(r.error)) throw new Error("expected a BilincError");
  return r.error;
}

describe("wire format per operation", () => {
  it("status: GET /status, no body, maps credits and the sidecar version", async () => {
    const m = mockFetch(json(200, statusFixture));
    const { client } = makeClient();
    expect(await client.status()).toEqual({
      credits: { availableTotalCredits: 1988, monthlyRemainingCredits: 1988 },
      capabilities: statusFixture.capabilities,
      recallProfiles: ["fast", "balanced"],
      runtimeVersion: "2.7.3",
    });
    expect(m.sent[0]).toMatchObject({ method: "GET", url: `${API}/status`, body: undefined });
    expect(m.sent[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("status: null credits stay null, and a missing runtime gives a null runtimeVersion", async () => {
    mockFetch(ok({ credits: null, capabilities: {}, recallProfiles: [] }));
    const status = await makeClient().client.status();
    expect(status.credits).toBeNull();
    expect(status.runtimeVersion).toBeNull();
  });

  it("commit: camelCase body, never importance, maps affected_keys", async () => {
    const m = mockFetch(json(201, commitFixture));
    const { client } = makeClient();
    const result = await client.commit({
      key: "cf.default.favorite-color",
      value: "green",
      source: "cloudflare-agent",
      sessionId: "chat-1",
      metadata: { agentId: "a", namespace: "default" },
    });
    expect(result).toEqual({ entryVersion: "ev_3f2a9c", affectedKeys: ["cf.default.favorite-color"], warnings: [] });
    expect(m.sent[0]).toMatchObject({ method: "POST", url: `${API}/memory/commit` });
    expect(m.sent[0]?.body).toEqual({
      key: "cf.default.favorite-color",
      value: "green",
      source: "cloudflare-agent",
      sessionId: "chat-1",
      metadata: { agentId: "a", namespace: "default" },
    });
    expect(m.sent[0]?.headers["idempotency-key"]).toMatch(UUID_RE);
  });

  it("commit: passes secret_redacted warnings through", async () => {
    mockFetch(json(201, { ...commitFixture, warnings: [{ code: "secret_redacted", rule: "bearer", field: "value" }, { code: 1 }] }));
    const r = await makeClient().client.commit({ key: "k", value: "Authorization: Bearer x" });
    expect(r.warnings).toEqual([{ code: "secret_redacted", rule: "bearer", field: "value" }]);
  });

  it("commit: a sessionId over 256 chars is sent as sha256:<hex>", async () => {
    const m = mockFetch(json(201, commitFixture));
    await makeClient().client.commit({ key: "k", value: "v", sessionId: "x".repeat(300) });
    // sha256 of "x" repeated 300 times
    expect((m.sent[0]?.body as { sessionId: string }).sessionId).toBe(
      "sha256:0d4e2ca9e9cbced7a7a5380eb29e1a3783b9b6d0db72de36a1051038e1c1fbc7",
    );
  });

  it("commit: a long sessionId is hashed after trimming, so padding does not change the hash", async () => {
    const m = mockFetch(json(201, { entryVersion: "ev_1", affected_keys: [], warnings: [] }));
    await makeClient().client.commit({ key: "k", value: "v", sessionId: `  ${"x".repeat(300)}\n` });
    expect((m.sent[0]?.body as { sessionId: string }).sessionId).toBe(
      "sha256:0d4e2ca9e9cbced7a7a5380eb29e1a3783b9b6d0db72de36a1051038e1c1fbc7",
    );
  });

  it("commit: a sessionId of exactly 256 chars is sent unchanged", async () => {
    const m = mockFetch(json(201, commitFixture));
    await makeClient().client.commit({ key: "k", value: "v", sessionId: "y".repeat(256) });
    expect((m.sent[0]?.body as { sessionId: string }).sessionId).toBe("y".repeat(256));
  });

  it("recall: snake_case mapping, epoch seconds to ISO, non-string values stringified", async () => {
    const m = mockFetch(json(200, recallFixture));
    const hits = await makeClient().client.recall({ query: "favorite color", profile: "fast", limit: 20 });
    expect(m.sent[0]).toMatchObject({ method: "POST", url: `${API}/memory/recall`, body: { query: "favorite color", profile: "fast", limit: 20 } });
    expect(hits).toEqual([
      {
        key: "cf.default.favorite-color",
        value: "The user's favorite color is green.",
        entryVersion: "ev_3f2a9c",
        updatedAt: "2025-11-23T12:13:20.000Z",
        source: "cloudflare-agent",
      },
      { key: "cf.default.home-city", value: '{"city":"Istanbul"}', entryVersion: "ev_9b1c00", updatedAt: "2025-11-23T09:26:40.000Z", source: null },
      { key: "notes.unloaded", value: "an entry the runtime could not load provenance for", entryVersion: null, updatedAt: null, source: null },
    ]);
  });

  it("recall: defaults profile balanced and limit 20; a fresh Idempotency-Key per call", async () => {
    const m = mockFetch(json(200, recallFixture));
    const { client } = makeClient();
    await client.recall({ query: "a" });
    await client.recall({ query: "a" });
    expect(m.sent[0]?.body).toEqual({ query: "a", profile: "balanced", limit: 20 });
    const [k1, k2] = [m.sent[0]?.headers["idempotency-key"], m.sent[1]?.headers["idempotency-key"]];
    expect(k1).toMatch(UUID_RE);
    expect(k2).toMatch(UUID_RE);
    expect(k1).not.toBe(k2);
  });

  it("recall: an unexpected shape is no results", async () => {
    mockFetch(ok({ results: "nope" }));
    expect(await makeClient().client.recall({ query: "a" })).toEqual([]);
  });

  it("recall: an updated_at too large for a Date is updatedAt null, not an error", async () => {
    mockFetch(ok({ results: [{ key: "cf.default.k", value: "v", entry_version: "ev_1", updated_at: 1e300, source: null }] }));
    const { client, onError } = makeClient();
    expect(await client.recall({ query: "a" })).toEqual([{ key: "cf.default.k", value: "v", entryVersion: "ev_1", updatedAt: null, source: null }]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("any throw while mapping a 2xx body is bad_response: onError once, breaker counts", async () => {
    const marker = { boom: true };
    const stringify = JSON.stringify.bind(JSON);
    vi.spyOn(JSON, "stringify").mockImplementation((value: unknown, ...rest: unknown[]) => {
      if (typeof value === "object" && value !== null && (value as { boom?: unknown }).boom === true) throw new TypeError("mapper broke");
      return stringify(value, ...(rest as [undefined, undefined]));
    });
    try {
      mockFetch(ok({ results: [{ key: "cf.default.k", value: marker }] }));
      const { client, onError, guard } = makeClient();
      const e = await rejection(client.recall({ query: "a" }));
      expect(e).toMatchObject({ code: "bad_response", status: 200, outcomeUnknown: false });
      expect(onError).toHaveBeenCalledExactlyOnceWith(e, "recall");
      expect(guard.state().failures).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("recall: a query over 4,096 chars is cut to exactly 4,096 and sent", async () => {
    const m = mockFetch(json(200, recallFixture));
    await makeClient().client.recall({ query: "q".repeat(5000) });
    expect((m.sent[0]?.body as { query: string }).query).toHaveLength(4096);
  });

  it("list: body and camelCase mapping", async () => {
    const m = mockFetch(json(200, listFixture));
    const r = await makeClient().client.list({ prefix: "cf.default.", order: "newest", values: "none", limit: 10 });
    expect(m.sent[0]).toMatchObject({ url: `${API}/memory/list`, body: { prefix: "cf.default.", order: "newest", values: "none", limit: 10 } });
    expect(m.sent[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(r).toEqual({
      total: 2,
      nextCursor: null,
      entries: [
        { key: "cf.default.favorite-color", updatedAt: "2026-11-23T08:00:00.000Z", entryVersion: "ev_3f2a9c" },
        { key: "cf.default.home-city", updatedAt: "2026-11-22T08:00:00.000Z", entryVersion: "ev_9b1c00" },
      ],
    });
  });

  it("list: entries that are not an array is bad_response", async () => {
    mockFetch(ok({ entries: null }));
    expect((await rejection(makeClient().client.list())).code).toBe("bad_response");
  });

  it("history: body and mapping", async () => {
    const m = mockFetch(json(200, historyFixture));
    const r = await makeClient().client.history({ key: "cf.default.favorite-color", values: "preview", limit: 20 });
    expect(m.sent[0]).toMatchObject({ url: `${API}/memory/history`, body: { key: "cf.default.favorite-color", values: "preview", limit: 20 } });
    expect(r).toEqual({
      key: "cf.default.favorite-color",
      exists: true,
      truncated: false,
      entries: [
        { op: "commit", at: "2026-11-23T08:00:00.000Z", reason: null, source: "cloudflare-agent", before: "The user's favorite color is blue.", after: "The user's favorite color is green." },
        { op: "commit", at: "2026-11-22T08:00:00.000Z", reason: null, source: "cloudflare-agent", after: "The user's favorite color is blue." },
      ],
    });
  });

  it("createSnapshot: label and empty metadata; maps the nested snapshot", async () => {
    const m = mockFetch(
      json(201, { snapshot: { id: "snap_new", createdAt: "2026-11-23T12:00:00.000Z", totalEntries: 3, byType: {}, rootHash: "r", label: "before", metadata: {} } }),
    );
    const r = await makeClient().client.createSnapshot({ label: "before" });
    expect(m.sent[0]).toMatchObject({ url: `${API}/memory/snapshots`, method: "POST", body: { label: "before", metadata: {} } });
    expect(m.sent[0]?.headers["idempotency-key"]).toMatch(UUID_RE);
    expect(r).toEqual({ id: "snap_new", label: "before", createdAt: "2026-11-23T12:00:00.000Z", totalEntries: 3 });
  });

  it("createSnapshot: a 201 without a snapshot id is bad_response with outcome unknown", async () => {
    mockFetch(json(201, { snapshot: {} }));
    const e = await rejection(makeClient().client.createSnapshot({}));
    expect(e.code).toBe("bad_response");
    expect(e.outcomeUnknown).toBe(true);
    expect(noticeFor(e, "createSnapshot")).toBe(NOTICES.outcomeUnknown);
  });

  it("listSnapshots: limit query, server order, drops items without an id", async () => {
    const m = mockFetch(json(200, snapshotsFixture));
    const r = await makeClient().client.listSnapshots();
    expect(m.sent[0]).toMatchObject({ method: "GET", url: `${API}/memory/snapshots?limit=20`, body: undefined });
    expect(r).toEqual([
      { id: "snap_20261123_c3", label: "before the import", createdAt: "2026-11-23T10:02:00.000Z", totalEntries: 12 },
      { id: "snap_20261123_b2", label: "auto: chat start 2026-11-23T09:30:00.000Z", createdAt: "2026-11-23T09:30:00.000Z", totalEntries: 10 },
      { id: "snap_20261122_a1", label: null, createdAt: "2026-11-22T18:00:00.000Z", totalEntries: 8 },
    ]);
  });

  it("listSnapshots: given limit, empty array, non-array is bad_response", async () => {
    const m = mockFetch(ok({ snapshots: [] }), ok({ snapshots: {} }));
    const { client } = makeClient();
    expect(await client.listSnapshots({ limit: 100 })).toEqual([]);
    expect(m.sent[0]?.url).toBe(`${API}/memory/snapshots?limit=100`);
    expect((await rejection(client.listSnapshots({ limit: 1 }))).code).toBe("bad_response");
  });

  it("diff: snake_case keys, includeValues false", async () => {
    const m = mockFetch(json(200, diffFixture));
    const r = await makeClient().client.diff({ fromSnapshotId: "snap_20261123_a1", limit: 100 });
    expect(m.sent[0]).toMatchObject({ url: `${API}/memory/diff`, body: { fromSnapshotId: "snap_20261123_a1", includeValues: false, limit: 100 } });
    expect(r).toEqual({
      counts: { added: 1, modified: 2, removed: 1 },
      added: ["cf.default.new-fact"],
      modified: ["cf.default.favorite-color", "other.project.key"],
      removed: ["cf.default.old-fact"],
      truncated: false,
    });
  });

  it("rollbackPreview: free, camelCase, keeps the token for the caller", async () => {
    const m = mockFetch(json(200, previewFixture));
    const r = await makeClient().client.rollbackPreview({ snapshotId: "snap_20261123_c3", reason: "  undo the import  " });
    expect(m.sent[0]).toMatchObject({ url: `${API}/memory/rollback/preview`, body: { snapshotId: "snap_20261123_c3", reason: "undo the import" } });
    expect(m.sent[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(r).toEqual({
      snapshotId: "snap_20261123_c3",
      counts: { create: 1, update: 2, remove: 3 },
      createKeys: ["cf.default.old-fact"],
      updateKeys: ["cf.default.favorite-color", "other.project.key"],
      removeKeys: ["cf.default.a", "cf.default.b", "cf.default.c"],
      truncated: false,
      confirmationToken: "rbt_secret_token_value",
      confirmationExpiresAt: "2026-11-23T12:05:00.000Z",
    });
  });

  it("rollback: write with token; maps counts", async () => {
    const m = mockFetch(ok({ success: true, mode: "execute", snapshotId: "snap_1", counts: { created: 1, updated: 2, deleted: 3 } }));
    const r = await makeClient().client.rollback({ snapshotId: "snap_1", reason: "undo", confirmationToken: "tok" });
    expect(m.sent[0]).toMatchObject({ url: `${API}/memory/rollback`, body: { snapshotId: "snap_1", reason: "undo", confirmationToken: "tok" } });
    expect(m.sent[0]?.headers["idempotency-key"]).toMatch(UUID_RE);
    expect(r).toEqual({ snapshotId: "snap_1", counts: { created: 1, updated: 2, deleted: 3 } });
  });

  it("forget: body without purge; expectedVersion only when given", async () => {
    const m = mockFetch(ok({ success: true, key: "cf.default.x", removed: true, reasonRecorded: true }));
    const { client } = makeClient();
    expect(await client.forget({ key: "cf.default.x", reason: "wrong" })).toEqual({ key: "cf.default.x", removed: true });
    await client.forget({ key: "cf.default.x", reason: "wrong", expectedVersion: "ev_1" });
    expect(m.sent[0]?.body).toEqual({ key: "cf.default.x", reason: "wrong" });
    expect(m.sent[1]?.body).toEqual({ key: "cf.default.x", reason: "wrong", expectedVersion: "ev_1" });
    expect(JSON.stringify(m.sent)).not.toContain("purge");
  });
});

describe("client-side validation: never sent", () => {
  const cases: [string, (c: ReturnType<typeof makeClient>["client"]) => Promise<unknown>, string, string, string][] = [
    ["reason missing", (c) => c.forget({ key: "k", reason: "   " }), "forget", "reason", "required"],
    ["reason 513 chars", (c) => c.forget({ key: "k", reason: "r".repeat(513) }), "forget", "reason", "too_long"],
    ["reason dream:", (c) => c.rollbackPreview({ snapshotId: "s1", reason: " dream: tidy" }), "rollbackPreview", "reason", "reserved_reason"],
    ["label 129 chars", (c) => c.createSnapshot({ label: "l".repeat(129) }), "createSnapshot", "label", "too_long"],
    ["label blank", (c) => c.createSnapshot({ label: "  " }), "createSnapshot", "label", "empty"],
    ["expectedVersion 129 chars", (c) => c.forget({ key: "k", reason: "r", expectedVersion: "v".repeat(129) }), "forget", "expectedVersion", "too_long"],
    ["diff snapshotId", (c) => c.diff({ fromSnapshotId: "../etc" }), "diff", "fromSnapshotId", "pattern"],
    ["preview snapshotId", (c) => c.rollbackPreview({ snapshotId: "a b", reason: "r" }), "rollbackPreview", "snapshotId", "pattern"],
    ["rollback snapshotId", (c) => c.rollback({ snapshotId: "x".repeat(129), reason: "r", confirmationToken: "t" }), "rollback", "snapshotId", "pattern"],
    ["rollback token", (c) => c.rollback({ snapshotId: "s1", reason: "r", confirmationToken: "" }), "rollback", "confirmationToken", "required"],
    ["listSnapshots limit 0", (c) => c.listSnapshots({ limit: 0 }), "listSnapshots", "limit", "range"],
    ["listSnapshots limit 101", (c) => c.listSnapshots({ limit: 101 }), "listSnapshots", "limit", "range"],
    ["listSnapshots limit 1.5", (c) => c.listSnapshots({ limit: 1.5 }), "listSnapshots", "limit", "range"],
  ];

  it.each(cases)("%s", async (_name, call, op, field, reason) => {
    const m = mockFetch(ok({}));
    const { client, onError, guard } = makeClient();
    const e = await rejection(call(client));
    expect(m.fn).not.toHaveBeenCalled();
    expect(e).toMatchObject({ code: "invalid_request", status: 0, details: { field, reason }, outcomeUnknown: false });
    expect(onError).toHaveBeenCalledExactlyOnceWith(e, op);
    expect(guard.state().failures).toBe(0);
  });

  it("a bad snapshot id gives the checkpoint notice", async () => {
    mockFetch(ok({}));
    const e = await rejection(makeClient().client.diff({ fromSnapshotId: "no spaces allowed" }));
    expect(noticeFor(e, "diff")).toBe(NOTICES.checkpointNotFound);
  });

  it("a reason of exactly 512 chars and a label of exactly 128 are sent", async () => {
    const m = mockFetch(ok({ success: true, key: "k", removed: true }));
    await makeClient().client.forget({ key: "k", reason: "r".repeat(512) });
    expect(m.fn).toHaveBeenCalledTimes(1);
    mockFetch(json(201, { snapshot: { id: "s", createdAt: "", totalEntries: 0, label: "l".repeat(128) } }));
    expect((await makeClient().client.createSnapshot({ label: "l".repeat(128) })).label).toHaveLength(128);
  });
});

describe("onError", () => {
  it("is called once per failed call with the op, never on success", async () => {
    mockFetch(ok({ entries: [], total: 0, nextCursor: null }), json(404, { error: "memory_not_found", requestId: "req_x" }));
    const { client, onError } = makeClient();
    await client.list();
    expect(onError).not.toHaveBeenCalled();
    const e = await rejection(client.history({ key: "cf.default.nope" }));
    expect(onError).toHaveBeenCalledExactlyOnceWith(e, "history");
    expect(e.requestId).toBe("req_x");
  });

  it("a throwing onError does not change the outcome", async () => {
    mockFetch(json(404, { error: "memory_not_found" }));
    const { client, onError } = makeClient();
    onError.mockImplementation(() => {
      throw new Error("logger broke");
    });
    expect((await rejection(client.history({ key: "k" }))).code).toBe("memory_not_found");
  });
});
