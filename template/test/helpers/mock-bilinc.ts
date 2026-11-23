// A stateful in-memory stand-in for the Bilinc Cloud REST API at https://bilinc.space/api/cloud.
// It replaces globalThis.fetch; the Durable Objects under test run in the same isolate, so they see it.
// Casing follows the wire: list/history/snapshots/preview/rollback camelCase, recall/diff snake_case,
// commit mixed (affected_keys next to entryVersion).

export const TEST_API_KEY = "bil_live_test_key";
const BASE = "https://bilinc.space/api/cloud";

export interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

interface Entry {
  value: string;
  version: number;
  updatedAt: number; // epoch seconds
  seq: number;
  source: string | null;
}

interface HistoryEvent {
  op: string;
  at: string;
  reason: string | null;
  source: string | null;
  before?: string;
  after?: string;
}

interface Snapshot {
  id: string;
  label: string | null;
  createdAt: string;
  state: Map<string, string>;
}

type Override = (call: RecordedCall, signal: AbortSignal) => Response | Promise<Response>;

export interface MockBilinc {
  calls: RecordedCall[];
  callsTo(method: string, path: string): RecordedCall[];
  /** Answer every request to `${method} ${path}` with `handler` until cleared. */
  override(route: string, handler: Override): void;
  clearOverrides(): void;
  /** Value stored under a full key, or undefined. */
  value(key: string): string | undefined;
  snapshotLabels(): (string | null)[];
  restore(): void;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function bilincError(status: number, code: string, details?: unknown): Response {
  return jsonResponse(status, { error: code, message: code, requestId: `req_${code}`, retryable: false, details });
}

export function htmlPage(status: number, headers: Record<string, string> = {}): Response {
  return new Response("<html><body>edge page</body></html>", { status, headers: { "Content-Type": "text/html", ...headers } });
}

/**
 * A response that settles only after `release()`, or rejects when the request is aborted.
 * It polls instead of holding a resolver: a promise created inside a Durable Object must be
 * settled from that Durable Object's own I/O context, never from the test's.
 */
export function deferredResponse(): { handler: Override; release(): void } {
  let released = false;
  return {
    handler: async (_call, signal) => {
      while (!released) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        await new Promise((r) => setTimeout(r, 10));
      }
      return jsonResponse(201, {
        snapshot: { id: "snap_late", label: "auto: chat start late", createdAt: new Date().toISOString(), totalEntries: 0 },
      });
    },
    release() {
      released = true;
    },
  };
}

export function installMockBilinc(options: { apiKey?: string } = {}): MockBilinc {
  const expectedKey = options.apiKey ?? TEST_API_KEY;
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  const entries = new Map<string, Entry>();
  const history = new Map<string, HistoryEvent[]>();
  const snapshots: Snapshot[] = [];
  const previews = new Map<string, { snapshotId: string; reason: string }>();
  const overrides = new Map<string, Override>();
  let seq = 0;

  const now = () => Math.floor(Date.now() / 1000);
  const record = (key: string, event: HistoryEvent) => {
    const list = history.get(key) ?? [];
    list.unshift(event);
    history.set(key, list);
  };
  const currentState = () => new Map([...entries].map(([k, e]) => [k, e.value]));

  async function route(call: RecordedCall, url: URL): Promise<Response> {
    const auth = call.headers["authorization"];
    if (!auth) return bilincError(401, "missing_api_key");
    if (auth !== `Bearer ${expectedKey}`) return bilincError(401, "invalid_api_key");
    const b = call.body ?? {};

    switch (`${call.method} ${call.path}`) {
      case "GET /status":
        return jsonResponse(200, {
          status: "ok",
          credits: { availableTotalCredits: 2000, monthlyRemainingCredits: 2000 },
          capabilities: {},
          recallProfiles: ["fast", "balanced"],
        });
      case "POST /memory/list": {
        const prefix = typeof b.prefix === "string" ? b.prefix : "";
        const limit = typeof b.limit === "number" ? b.limit : 50;
        const matching = [...entries].filter(([k]) => k.startsWith(prefix)).sort((x, y) => y[1].seq - x[1].seq);
        return jsonResponse(200, {
          total: matching.length,
          entries: matching.slice(0, limit).map(([key, e]) => ({
            key,
            updatedAt: new Date(e.updatedAt * 1000).toISOString(),
            entryVersion: `v${e.version}`,
          })),
          nextCursor: null,
        });
      }
      case "POST /memory/recall": {
        const words = String(b.query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
        const limit = typeof b.limit === "number" ? b.limit : 10;
        const hits = [...entries]
          .filter(([k, e]) => words.some((w) => e.value.toLowerCase().includes(w) || k.includes(w)))
          .sort((x, y) => y[1].seq - x[1].seq)
          .slice(0, limit);
        return jsonResponse(200, {
          results: hits.map(([key, e]) => ({
            key,
            value: e.value,
            entry_version: `v${e.version}`,
            source: e.source,
            created_at: e.updatedAt,
            updated_at: e.updatedAt,
          })),
        });
      }
      case "POST /memory/commit": {
        const key = String(b.key);
        const value = String(b.value);
        const prev = entries.get(key);
        const entry: Entry = {
          value,
          version: (prev?.version ?? 0) + 1,
          updatedAt: now(),
          seq: ++seq,
          source: typeof b.source === "string" ? b.source : null,
        };
        entries.set(key, entry);
        record(key, { op: prev ? "update" : "create", at: new Date().toISOString(), reason: null, source: entry.source, before: prev?.value, after: value });
        return jsonResponse(201, { success: true, affected_keys: [key], entryVersion: `v${entry.version}`, warnings: [] });
      }
      case "POST /memory/history": {
        const key = String(b.key);
        const events = history.get(key) ?? [];
        return jsonResponse(200, { key, exists: entries.has(key), entries: events.slice(0, 20), truncated: events.length > 20 });
      }
      case "POST /memory/snapshots": {
        const snap: Snapshot = {
          id: `snap_${snapshots.length + 1}`,
          label: typeof b.label === "string" ? b.label : null,
          createdAt: new Date().toISOString(),
          state: currentState(),
        };
        snapshots.push(snap);
        return jsonResponse(201, {
          snapshot: { id: snap.id, label: snap.label, createdAt: snap.createdAt, totalEntries: snap.state.size, byType: {}, rootHash: `root_${snap.id}`, metadata: {} },
        });
      }
      case "GET /memory/snapshots": {
        const limit = Number(url.searchParams.get("limit") ?? "20");
        return jsonResponse(200, {
          snapshots: [...snapshots].reverse().slice(0, limit).map((s) => ({
            id: s.id, label: s.label, createdAt: s.createdAt, totalEntries: s.state.size, byType: {}, rootHash: `root_${s.id}`, metadata: {},
          })),
        });
      }
      case "POST /memory/diff": {
        const snap = snapshots.find((s) => s.id === b.fromSnapshotId);
        if (!snap) return bilincError(404, "snapshot_not_found");
        const current = currentState();
        const added = [...current.keys()].filter((k) => !snap.state.has(k)).sort();
        const removed = [...snap.state.keys()].filter((k) => !current.has(k)).sort();
        const modified = [...current.keys()].filter((k) => snap.state.has(k) && snap.state.get(k) !== current.get(k)).sort();
        return jsonResponse(200, {
          from_snapshot_id: snap.id,
          to_snapshot_id: null,
          counts: { added: added.length, modified: modified.length, removed: removed.length },
          added: added.map((key) => ({ key })),
          modified: modified.map((key) => ({ key })),
          removed: removed.map((key) => ({ key })),
          values_included: false,
          truncated: false,
        });
      }
      case "POST /memory/rollback/preview": {
        const snap = snapshots.find((s) => s.id === b.snapshotId);
        if (!snap) return bilincError(404, "snapshot_not_found");
        const current = currentState();
        const createKeys = [...snap.state.keys()].filter((k) => !current.has(k)).sort();
        const removeKeys = [...current.keys()].filter((k) => !snap.state.has(k)).sort();
        const updateKeys = [...snap.state.keys()].filter((k) => current.has(k) && current.get(k) !== snap.state.get(k)).sort();
        const token = `tok_${crypto.randomUUID()}`;
        previews.set(token, { snapshotId: snap.id, reason: String(b.reason) });
        return jsonResponse(200, {
          mode: "preview",
          snapshotId: snap.id,
          counts: { create: createKeys.length, update: updateKeys.length, remove: removeKeys.length },
          createKeys,
          updateKeys,
          removeKeys,
          truncated: false,
          confirmationToken: token,
          confirmationExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          destructive: true,
        });
      }
      case "POST /memory/rollback": {
        const preview = previews.get(String(b.confirmationToken));
        if (!preview || preview.snapshotId !== b.snapshotId || preview.reason !== b.reason) {
          return bilincError(410, "rollback_confirmation_expired");
        }
        previews.delete(String(b.confirmationToken));
        const snap = snapshots.find((s) => s.id === preview.snapshotId)!;
        let created = 0;
        let updated = 0;
        let deleted = 0;
        for (const key of [...entries.keys()]) {
          if (!snap.state.has(key)) {
            entries.delete(key);
            deleted++;
          }
        }
        for (const [key, value] of snap.state) {
          const prev = entries.get(key);
          if (prev?.value === value) continue;
          if (prev) updated++;
          else created++;
          entries.set(key, { value, version: (prev?.version ?? 0) + 1, updatedAt: now(), seq: ++seq, source: "rollback" });
          record(key, { op: "rollback", at: new Date().toISOString(), reason: preview.reason, source: "rollback", before: prev?.value, after: value });
        }
        return jsonResponse(200, { snapshotId: snap.id, counts: { created, updated, deleted } });
      }
      case "POST /memory/forget": {
        const key = String(b.key);
        const prev = entries.get(key);
        if (!prev) return bilincError(404, "memory_not_found");
        entries.delete(key);
        record(key, { op: "forget", at: new Date().toISOString(), reason: String(b.reason), source: "cloudflare-agent" });
        return jsonResponse(200, { key, removed: true });
      }
      default:
        return bilincError(404, "not_found");
    }
  }

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(request.url);
    if (!request.url.startsWith(`${BASE}/`)) {
      throw new Error(`mock-bilinc: unexpected fetch to ${url.origin}${url.pathname}`);
    }
    if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
    const text = request.method === "GET" ? "" : await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: RecordedCall = {
      method: request.method,
      path: url.pathname.slice("/api/cloud".length),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      headers,
    };
    calls.push(call);
    const override = overrides.get(`${call.method} ${call.path}`);
    return override ? override(call, request.signal) : route(call, url);
  };

  globalThis.fetch = mockFetch as typeof fetch;

  return {
    calls,
    callsTo: (method, path) => calls.filter((c) => c.method === method && c.path === path),
    override: (r, handler) => void overrides.set(r, handler),
    clearOverrides: () => overrides.clear(),
    value: (key) => entries.get(key)?.value,
    snapshotLabels: () => snapshots.map((s) => s.label),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
