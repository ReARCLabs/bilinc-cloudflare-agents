import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BilincClient, DiffResult, RollbackPreview } from '../src/index';
import { installShapeRecorder, runGate, secretSamples } from '../scripts/gate.mjs';

class FakeBilincError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId = 'req-fake';

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

interface FakeOptions {
  recallCost?: number;
  tokenTtlMs?: number;
  startEntries?: number;
  runtimeVersion?: string | null;
}

/** An in-memory Bilinc that follows the spec's credit table and rollback-token rules. Nothing here touches the network. */
function fakeBilinc(options: FakeOptions = {}) {
  const recallCost = options.recallCost ?? 1;
  const tokenTtlMs = options.tokenTtlMs ?? 300_000;
  const at = '2026-11-23T12:00:00.000Z';
  let credits = 2000;
  let clock = 0;
  let seq = 0;
  const entries = new Map<string, string>();
  const versions = new Map<string, number>();
  for (let i = 0; i < (options.startEntries ?? 0); i += 1) entries.set(`old-${i}`, 'old');
  const snapshots: { id: string; label: string | null; createdAt: string; totalEntries: number; state: Map<string, string> }[] = [];
  const previews = new Map<string, { snapshotId: string; reason: string; expiresAt: number; used: boolean }>();
  const sleeps: number[] = [];

  const findSnapshot = (id: string) => {
    const snapshot = snapshots.find((candidate) => candidate.id === id);
    if (snapshot === undefined) throw new FakeBilincError('snapshot_not_found', 404);
    return snapshot;
  };
  const compare = (state: Map<string, string>) => ({
    added: [...entries.keys()].filter((key) => !state.has(key)),
    modified: [...entries.keys()].filter((key) => state.has(key) && state.get(key) !== entries.get(key)),
    removed: [...state.keys()].filter((key) => !entries.has(key)),
  });

  const client: BilincClient = {
    async status() {
      return {
        credits: { availableTotalCredits: credits, monthlyRemainingCredits: credits },
        capabilities: { commit: true, recall: true, forget: true, snapshots: true, diff: true, rollback: true, history: true, list: true },
        recallProfiles: ['fast', 'balanced'],
        runtimeVersion: options.runtimeVersion === undefined ? '2.7.3' : options.runtimeVersion,
      };
    },
    async list(input) {
      const keys = [...entries.keys()].filter((key) => key.startsWith(input?.prefix ?? ''));
      return {
        total: keys.length,
        entries: keys.map((key) => ({ key, updatedAt: at, entryVersion: `v${versions.get(key) ?? 0}` })),
        nextCursor: null,
      };
    },
    async commit(input) {
      if (/\bghp_[A-Za-z0-9]{36,}/.test(input.value)) throw new FakeBilincError('secret_detected', 422);
      credits -= 1;
      entries.set(input.key, input.value);
      versions.set(input.key, (versions.get(input.key) ?? 0) + 1);
      const warnings = input.value.includes('password=') ? [{ code: 'secret_redacted', rule: 'assignment', field: 'value' }] : [];
      return { entryVersion: `v${versions.get(input.key) ?? 0}`, affectedKeys: [input.key], warnings };
    },
    async recall() {
      credits -= recallCost;
      return [...entries].map(([key, value]) => ({
        key,
        value,
        entryVersion: `v${versions.get(key) ?? 0}`,
        updatedAt: at,
        source: 'cloudflare-agent',
      }));
    },
    async history(input) {
      return {
        key: input.key,
        exists: entries.has(input.key),
        truncated: false,
        entries: Array.from({ length: versions.get(input.key) ?? 0 }, () => ({ op: 'commit', at, reason: null, source: 'cloudflare-agent' })),
      };
    },
    async createSnapshot(input) {
      credits -= 2;
      seq += 1;
      const snapshot = { id: `snap-${seq}`, label: input?.label ?? null, createdAt: at, totalEntries: entries.size, state: new Map(entries) };
      snapshots.unshift(snapshot);
      return { id: snapshot.id, label: snapshot.label, createdAt: snapshot.createdAt, totalEntries: snapshot.totalEntries };
    },
    async listSnapshots(input) {
      return snapshots
        .slice(0, input?.limit ?? 20)
        .map(({ id, label, createdAt, totalEntries }) => ({ id, label, createdAt, totalEntries }));
    },
    async diff(input): Promise<DiffResult> {
      const { added, modified, removed } = compare(findSnapshot(input.fromSnapshotId).state);
      return { counts: { added: added.length, modified: modified.length, removed: removed.length }, added, modified, removed, truncated: false };
    },
    async rollbackPreview(input): Promise<RollbackPreview> {
      const { added, modified, removed } = compare(findSnapshot(input.snapshotId).state);
      seq += 1;
      const confirmationToken = `tok-${seq}`;
      previews.set(confirmationToken, { snapshotId: input.snapshotId, reason: input.reason, expiresAt: clock + tokenTtlMs, used: false });
      return {
        snapshotId: input.snapshotId,
        counts: { create: removed.length, update: modified.length, remove: added.length },
        createKeys: removed,
        updateKeys: modified,
        removeKeys: added,
        truncated: false,
        confirmationToken,
        confirmationExpiresAt: new Date(Date.now() + tokenTtlMs).toISOString(),
      };
    },
    async rollback(input) {
      const preview = previews.get(input.confirmationToken);
      if (preview === undefined || preview.used || preview.snapshotId !== input.snapshotId || preview.reason !== input.reason) {
        throw new FakeBilincError('state_changed_since_preview', 409);
      }
      if (clock >= preview.expiresAt) throw new FakeBilincError('rollback_confirmation_expired', 410);
      preview.used = true;
      credits -= 2;
      const state = findSnapshot(input.snapshotId).state;
      const { added, modified, removed } = compare(state);
      entries.clear();
      for (const [key, value] of state) entries.set(key, value);
      return { snapshotId: input.snapshotId, counts: { created: removed.length, updated: modified.length, deleted: added.length } };
    },
    async forget(input) {
      if (!entries.has(input.key)) throw new FakeBilincError('memory_not_found', 404);
      credits -= 1;
      entries.delete(input.key);
      return { key: input.key, removed: true };
    },
  };

  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
  return { bilinc: { client, prefix: 'cf.gate.' }, sleep, sleeps };
}

const quiet = () => undefined;
const failedIds = (report: { results: { id: string; ok: boolean }[] }) => report.results.filter((result) => !result.ok).map((result) => result.id);

describe('runGate against a fake Bilinc', () => {
  it('passes every check when Bilinc behaves as the spec says', async () => {
    const fake = fakeBilinc();
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r1', sleep: fake.sleep, log: quiet, waitForExpiry: true });
    expect(failedIds(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.results.map((result) => result.id)).toEqual(
      expect.arrayContaining([
        'project.empty',
        'status.capabilities',
        'status.runtime-version',
        'snapshots.empty',
        'list.order-newest',
        'commit.shape',
        'createSnapshot.shape',
        'listSnapshots.newest-first',
        'commit.upsert.history',
        'commit.upsert.total',
        'recall.shape',
        'diff.shape',
        'secret_scan.redacted',
        'secret_scan.detected',
        'error-body.snapshot_not_found',
        'preview.project-wide',
        'preview.token-ttl',
        'rollback.execute',
        'token.single-use',
        'rollback.restored',
        'token.expires-300s',
        'forget.removed',
        'credits.listSnapshots',
        'credits.recall',
        'credits.rollback',
        'credits.total',
      ]),
    );
  });

  it('records the sidecar version, and fails when status does not report one', async () => {
    const fake = fakeBilinc();
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r1v', sleep: fake.sleep, log: quiet });
    expect(report.results.find((result) => result.id === 'status.runtime-version')).toEqual({
      id: 'status.runtime-version',
      item: 'G5',
      ok: true,
      detail: 'sidecar runtime 2.7.3',
    });
    const missing = fakeBilinc({ runtimeVersion: null });
    const failed = await runGate({ bilinc: missing.bilinc, runId: 'r1n', sleep: missing.sleep, log: quiet });
    expect(failedIds(failed)).toEqual(['status.runtime-version']);
  });

  it('an exception mid-run keeps the checks so far and ends with a failing aborted check, never a secret or stack', async () => {
    const fake = fakeBilinc();
    const status = fake.bilinc.client.status.bind(fake.bilinc.client);
    let calls = 0;
    // The credit reads around each measured call go through status(); the sixth one throws.
    fake.bilinc.client.status = () => (++calls === 6 ? Promise.reject(new TypeError('boom with bil_live_abc123XYZ inside')) : status());
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r1a', sleep: fake.sleep, log: quiet });
    expect(report.ok).toBe(false);
    expect(report.results.find((result) => result.id === 'project.empty')?.ok).toBe(true);
    expect(report.results.length).toBeGreaterThan(2);
    const last = report.results.at(-1);
    expect(last).toMatchObject({ id: 'aborted', item: 'gate', ok: false });
    expect(last?.detail).toContain('TypeError: boom with');
    expect(JSON.stringify(report)).not.toContain('bil_live_abc123XYZ');
    expect(last?.detail).not.toContain('    at ');
  });

  it('an aborted run reports a Bilinc error by code and status', async () => {
    const fake = fakeBilinc();
    const status = fake.bilinc.client.status.bind(fake.bilinc.client);
    let calls = 0;
    fake.bilinc.client.status = () => (++calls === 6 ? Promise.reject(new FakeBilincError('cloud_runtime_unavailable', 503)) : status());
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r1b', sleep: fake.sleep, log: quiet });
    expect(report.results.at(-1)).toMatchObject({ id: 'aborted', ok: false, detail: 'cloud_runtime_unavailable 503' });
  });

  it('fails the credit checks when recall costs more than one credit', async () => {
    const fake = fakeBilinc({ recallCost: 2 });
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r2', sleep: fake.sleep, log: quiet });
    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(['credits.recall', 'credits.total']);
  });

  it('fails the expiry check when a token still works after 301 s', async () => {
    const fake = fakeBilinc({ tokenTtlMs: 600_000 });
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r3', sleep: fake.sleep, log: quiet, waitForExpiry: true });
    expect(failedIds(report)).toContain('token.expires-300s');
    expect(failedIds(report)).toContain('preview.token-ttl');
  });

  it('skips the 301 s wait unless asked', async () => {
    const fake = fakeBilinc();
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r4', sleep: fake.sleep, log: quiet });
    expect(report.ok).toBe(true);
    expect(fake.sleeps).toEqual([]);
    expect(report.results.some((result) => result.id === 'token.expires-300s')).toBe(false);
  });

  it('refuses a project that already holds entries, before any write', async () => {
    const fake = fakeBilinc({ startEntries: 2 });
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r5', sleep: fake.sleep, log: quiet });
    expect(report).toEqual({ ok: false, results: [{ id: 'project.empty', item: 'gate', ok: false, detail: '2 entries in the project' }] });
  });

  it('passes a second run on the same account, counting the first run\'s checkpoint', async () => {
    const fake = fakeBilinc();
    const first = await runGate({ bilinc: fake.bilinc, runId: 'r7a', sleep: fake.sleep, log: quiet });
    expect(failedIds(first)).toEqual([]);
    const second = await runGate({ bilinc: fake.bilinc, runId: 'r7b', sleep: fake.sleep, log: quiet });
    expect(failedIds(second)).toEqual([]);
    expect(second.results.find((result) => result.id === 'snapshots.empty')).toEqual({
      id: 'snapshots.empty',
      item: 'G6',
      ok: true,
      detail: '0 other checkpoints before the run, 1 from earlier gate runs',
    });
  });

  it('fails snapshots.empty on any checkpoint an earlier gate run did not make, unless allowNonEmpty', async () => {
    for (const label of ['before deploy', null, 'gate: restore x']) {
      const fake = fakeBilinc();
      await runGate({ bilinc: fake.bilinc, runId: 'r8a', sleep: fake.sleep, log: quiet });
      await fake.bilinc.client.createSnapshot(label === null ? {} : { label });
      const report = await runGate({ bilinc: fake.bilinc, runId: 'r8b', sleep: fake.sleep, log: quiet });
      expect(failedIds(report)).toEqual(['snapshots.empty']);
      expect(report.results.find((result) => result.id === 'snapshots.empty')?.detail).toBe(
        '1 other checkpoints before the run, 1 from earlier gate runs',
      );
      // The run stops there: no write, no checkpoint, no rollback on a project it does not own.
      expect(report.results.at(-1)?.id).toBe('snapshots.empty');
      expect((await fake.bilinc.client.listSnapshots({ limit: 100 })).length).toBe(2);
      const allowed = await runGate({ bilinc: fake.bilinc, runId: 'r8c', sleep: fake.sleep, log: quiet, allowNonEmpty: true });
      expect(failedIds(allowed)).toEqual([]);
    }
  });

  it('passes snapshots.empty on a full checkpoint list made only of earlier gate runs, and says older ones were not checked', async () => {
    const fake = fakeBilinc();
    for (let i = 0; i < 100; i += 1) await fake.bilinc.client.createSnapshot({ label: `gate: before change old${i}` });
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r9', sleep: fake.sleep, log: quiet });
    expect(failedIds(report)).toEqual([]);
    expect(report.results.find((result) => result.id === 'snapshots.empty')).toEqual({
      id: 'snapshots.empty',
      item: 'G6',
      ok: true,
      detail: '0 other checkpoints before the run, 100 from earlier gate runs; the list is full, so older checkpoints were not checked',
    });
  });

  it('fails snapshots.empty on a full checkpoint list that holds one checkpoint an earlier gate run did not make', async () => {
    const fake = fakeBilinc();
    await fake.bilinc.client.createSnapshot({ label: 'before deploy' });
    for (let i = 0; i < 99; i += 1) await fake.bilinc.client.createSnapshot({ label: `gate: before change old${i}` });
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r9b', sleep: fake.sleep, log: quiet });
    expect(failedIds(report)).toEqual(['snapshots.empty']);
    expect(report.results.find((result) => result.id === 'snapshots.empty')?.detail).toBe(
      '1 other checkpoints before the run, 99 from earlier gate runs; the list is full, so older checkpoints were not checked',
    );
  });

  it('logs one PASS or FAIL line per check', async () => {
    const fake = fakeBilinc();
    const lines: string[] = [];
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r6', sleep: fake.sleep, log: (line) => lines.push(line) });
    expect(lines).toHaveLength(report.results.length);
    expect(lines.every((line) => /^(PASS|FAIL) \S+ \S+ \(.*\)$/.test(line))).toBe(true);
  });
});

describe('secretSamples', () => {
  it('builds fresh secret-shaped text at run time', () => {
    const a = secretSamples();
    const b = secretSamples();
    expect(a.assignment).toMatch(/^gate note: password=[A-Za-z0-9]{16}$/);
    expect(a.providerShaped).toMatch(/^gate note: ghp_[A-Za-z0-9]{36}$/);
    expect(a.providerShaped).not.toBe(b.providerShaped);
  });
});

describe('installShapeRecorder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records method, path, status and key names, never values', async () => {
    const stub = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ key: 'cf.gate.k', value: 'stored text 123' }], _meta: { requestId: 'r' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', stub);
    const recorder = installShapeRecorder();
    await fetch('https://bilinc.space/api/cloud/memory/recall?x=1', { method: 'POST', body: '{}' });
    recorder.restore();
    expect(recorder.shapes).toEqual([
      {
        method: 'POST',
        path: '/api/cloud/memory/recall',
        status: 200,
        shape: { keys: ['_meta', 'results'], itemKeys: { _meta: ['requestId'], results: ['key', 'value'] } },
      },
    ]);
    expect(JSON.stringify(recorder.shapes)).not.toContain('stored text 123');
    expect(globalThis.fetch).toBe(stub);
  });
});

describe('gate CLI', () => {
  it('exits with code 2 before any request when BILINC_GATE_API_KEY is missing', () => {
    const script = fileURLToPath(new URL('../scripts/gate.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, 'report.json'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('BILINC_GATE_API_KEY is not set');
    expect(run.stdout).toBe('');
  });
});
