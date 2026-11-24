import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BilincClient, DiffResult, RollbackPreview } from '../src/index';
import { installShapeRecorder, readStatusUsage, runGate, secretSamples, writeReport } from '../scripts/gate.mjs';

class FakeBilincError extends Error {
  readonly code: string;
  readonly status: number;
  readonly outcomeUnknown: boolean;
  readonly requestId = 'req-fake';

  constructor(code: string, status: number, outcomeUnknown = false) {
    super(code);
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

interface FakeOptions {
  recallCost?: number;
  tokenTtlMs?: number;
  startEntries?: number;
  runtimeVersion?: string | null;
  /** An unmetered plan: status reports no credit balance, only `usage[].creditsEach`. */
  unmetered?: boolean;
  usage?: unknown;
}

const LIVE_USAGE = [
  { eventType: 'memory_write', used: 120, limit: null, limitedBy: null, creditsEach: 1 },
  { eventType: 'recall', used: 340, limit: null, limitedBy: null, creditsEach: 1 },
  { eventType: 'snapshot', used: 12, limit: null, limitedBy: null, creditsEach: 2 },
  { eventType: 'rollback', used: 4, limit: null, limitedBy: null, creditsEach: 2 },
];

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
        credits: options.unmetered
          ? { availableTotalCredits: null, monthlyRemainingCredits: null }
          : { availableTotalCredits: credits, monthlyRemainingCredits: credits },
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
  // Stands in for the gate's raw GET of /api/cloud/status: the package client's status() does not expose usage.
  const readUsage = async () => options.usage ?? LIVE_USAGE;
  return { bilinc: { client, prefix: 'cf.gate.' }, sleep, sleeps, readUsage };
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

  it('records the sidecar version when status reports one, and notes it when status does not', async () => {
    const fake = fakeBilinc();
    const report = await runGate({ bilinc: fake.bilinc, runId: 'r1v', sleep: fake.sleep, log: quiet });
    expect(report.results.find((result) => result.id === 'status.runtime-version')).toEqual({
      id: 'status.runtime-version',
      item: 'G5',
      ok: true,
      detail: 'sidecar runtime 2.7.3',
    });
    // Live /api/cloud/status reports only runtime: "ready" | "unavailable", never a version (bilinc-site app/api/cloud/status/route.ts).
    const missing = fakeBilinc({ runtimeVersion: null });
    const noted = await runGate({ bilinc: missing.bilinc, runId: 'r1n', sleep: missing.sleep, log: quiet });
    expect(failedIds(noted)).toEqual([]);
    expect(noted.results.find((result) => result.id === 'status.runtime-version')).toEqual({
      id: 'status.runtime-version',
      item: 'G5',
      ok: true,
      detail: 'sidecar runtime not reported by /api/cloud/status; record the deployed version from the server in GATE.md',
    });
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
    const last = report.results.find((result) => result.id === 'aborted');
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
    expect(report.results.find((result) => result.id === 'aborted')).toMatchObject({ id: 'aborted', ok: false, detail: 'cloud_runtime_unavailable 503' });
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

  it('makes no cleanup calls and adds no cleanup check when the run removed its own keys', async () => {
    const fake = fakeBilinc();
    const forget = vi.spyOn(fake.bilinc.client, 'forget');
    const report = await runGate({ bilinc: fake.bilinc, runId: 'rc0', sleep: fake.sleep, log: quiet, waitForExpiry: true });
    expect(failedIds(report)).toEqual([]);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(report.results.some((result) => result.id === 'cleanup')).toBe(false);
    expect((await fake.bilinc.client.list({})).total).toBe(0);
  });

  it.each([
    ['createSnapshot fails', 'createSnapshot', 1],
    ['rollbackPreview fails', 'rollbackPreview', 3],
    ['rollback fails', 'rollback', 2],
  ] as const)('forgets the keys this run left when %s, so the next run is not refused', async (_name, method, removed) => {
    const fake = fakeBilinc();
    Object.assign(fake.bilinc.client, { [method]: () => Promise.reject(new FakeBilincError('cloud_runtime_unavailable', 503)) });
    const report = await runGate({ bilinc: fake.bilinc, runId: 'rc1', sleep: fake.sleep, log: quiet });
    expect(report.ok).toBe(false);
    expect(report.results.find((result) => result.id === 'cleanup')).toEqual({
      id: 'cleanup',
      item: 'gate',
      ok: true,
      detail: `forgot ${removed} keys this run left behind`,
    });
    expect((await fake.bilinc.client.list({})).total).toBe(0);
  });

  it('does not try to forget a key whose commit was definitely refused (the secret_detected key was never written)', async () => {
    const fake = fakeBilinc();
    fake.bilinc.client.rollbackPreview = () => Promise.reject(new FakeBilincError('cloud_runtime_unavailable', 503));
    const forget = vi.spyOn(fake.bilinc.client, 'forget');
    const report = await runGate({ bilinc: fake.bilinc, runId: 'rc4', sleep: fake.sleep, log: quiet });
    expect(forget.mock.calls.map(([input]) => input.key)).not.toContain('cf.gate.gate-rc4-refused');
    expect(report.results.find((result) => result.id === 'cleanup')?.detail).toBe('forgot 3 keys this run left behind');
  });

  it('keeps a key whose commit got no definite answer, or threw something that is not a Bilinc answer', async () => {
    const fake = fakeBilinc();
    const commit = fake.bilinc.client.commit.bind(fake.bilinc.client);
    fake.bilinc.client.commit = (input) =>
      input.key.endsWith('-refused')
        ? Promise.reject(new TypeError('socket closed'))
        : input.key.endsWith('-redacted')
          ? commit(input).then(() => Promise.reject(new FakeBilincError('mutation_outcome_unknown', 503, true)))
          : commit(input);
    fake.bilinc.client.rollbackPreview = () => Promise.reject(new FakeBilincError('cloud_runtime_unavailable', 503));
    const forget = vi.spyOn(fake.bilinc.client, 'forget');
    await runGate({ bilinc: fake.bilinc, runId: 'rc5', sleep: fake.sleep, log: quiet });
    const forgotten = forget.mock.calls.map(([input]) => input.key);
    expect(forgotten).toContain('cf.gate.gate-rc5-refused');
    expect(forgotten).toContain('cf.gate.gate-rc5-redacted');
    expect((await fake.bilinc.client.list({})).total).toBe(0);
  });

  it('keeps a key written earlier in the run when a later commit to it is definitely refused', async () => {
    const fake = fakeBilinc();
    const commit = fake.bilinc.client.commit.bind(fake.bilinc.client);
    fake.bilinc.client.commit = (input) =>
      input.value.includes('red') ? Promise.reject(new FakeBilincError('version_conflict', 409)) : commit(input);
    fake.bilinc.client.rollbackPreview = () => Promise.reject(new FakeBilincError('cloud_runtime_unavailable', 503));
    const report = await runGate({ bilinc: fake.bilinc, runId: 'rc6', sleep: fake.sleep, log: quiet });
    expect(report.results.find((result) => result.id === 'cleanup')?.detail).toBe('forgot 3 keys this run left behind');
    expect((await fake.bilinc.client.list({})).total).toBe(0);
  });

  it('counts only keys forget really removed: removed false is neither removed nor still there', async () => {
    const fake = fakeBilinc();
    fake.bilinc.client.createSnapshot = () => Promise.reject(new FakeBilincError('cloud_runtime_unavailable', 503));
    fake.bilinc.client.forget = (input) => Promise.resolve({ key: input.key, removed: false });
    const report = await runGate({ bilinc: fake.bilinc, runId: 'rc7', sleep: fake.sleep, log: quiet });
    expect(report.results.find((result) => result.id === 'cleanup')).toEqual({
      id: 'cleanup',
      item: 'gate',
      ok: true,
      detail: 'forgot 0 keys this run left behind',
    });
  });

  it('forgets the keys this run left when it aborts', async () => {
    const fake = fakeBilinc();
    const status = fake.bilinc.client.status.bind(fake.bilinc.client);
    let calls = 0;
    fake.bilinc.client.status = () => (++calls === 6 ? Promise.reject(new TypeError('boom')) : status());
    const report = await runGate({ bilinc: fake.bilinc, runId: 'rc2', sleep: fake.sleep, log: quiet });
    expect(report.results.find((result) => result.id === 'aborted')?.ok).toBe(false);
    expect(report.results.find((result) => result.id === 'cleanup')?.ok).toBe(true);
    expect((await fake.bilinc.client.list({})).total).toBe(0);
  });

  it('never throws when cleanup fails, and names the keys still there', async () => {
    const fake = fakeBilinc();
    fake.bilinc.client.createSnapshot = () => Promise.reject(new FakeBilincError('cloud_runtime_unavailable', 503));
    fake.bilinc.client.forget = () => Promise.reject(new FakeBilincError('cloud_runtime_unavailable', 503));
    const report = await runGate({ bilinc: fake.bilinc, runId: 'rc3', sleep: fake.sleep, log: quiet });
    expect(report.ok).toBe(false);
    expect(report.results.find((result) => result.id === 'cleanup')).toEqual({
      id: 'cleanup',
      item: 'gate',
      ok: false,
      detail: 'forgot 0 keys this run left behind; still there: cf.gate.gate-rc3-fact (cloud_runtime_unavailable 503)',
    });
  });

  it('runs on an unmetered plan: checks unit costs from status instead of balance deltas', async () => {
    const fake = fakeBilinc({ unmetered: true });
    const lines: string[] = [];
    const report = await runGate({
      bilinc: fake.bilinc,
      runId: 'ru1',
      sleep: fake.sleep,
      log: (line) => lines.push(line),
      waitForExpiry: true,
      readUsage: fake.readUsage,
    });
    expect(failedIds(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.results.find((result) => result.id === 'credits.unmetered')).toEqual({
      id: 'credits.unmetered',
      item: 'G10',
      ok: true,
      detail: 'plan has no credit balance (unmetered); per-call costs were not measured by balance delta',
    });
    expect(report.results.find((result) => result.id === 'credits.unit-costs')).toMatchObject({
      id: 'credits.unit-costs',
      item: 'G10',
      ok: true,
    });
    expect(report.results.find((result) => result.id === 'credits.unit-costs')?.detail).toContain(
      'memory_write=1 recall=1 snapshot=2 rollback=2',
    );
    // No per-call balance checks and no total: only the two unmetered checks carry the credits. prefix.
    expect(report.results.map((result) => result.id).filter((id) => id.startsWith('credits.'))).toEqual([
      'credits.unmetered',
      'credits.unit-costs',
    ]);
    // The run still does all its work, and waits only for the token expiry, never for a balance to settle.
    expect(report.results.map((result) => result.id)).toEqual(
      expect.arrayContaining(['rollback.execute', 'rollback.restored', 'token.expires-300s', 'forget.removed']),
    );
    expect(fake.sleeps).toEqual([301_000]);
    expect(lines.filter((line) => /^(PASS|FAIL) /.test(line))).toHaveLength(report.results.length);
    expect((await fake.bilinc.client.list({})).total).toBe(0);
  });

  it.each([
    ['a different creditsEach', LIVE_USAGE.map((row) => (row.eventType === 'snapshot' ? { ...row, creditsEach: 3 } : row)), 'snapshot=3'],
    ['a missing event type', LIVE_USAGE.filter((row) => row.eventType !== 'rollback'), 'rollback=missing'],
    ['a usage that is not an array', { recall: 1 }, 'memory_write=missing'],
  ])('fails credits.unit-costs on %s', async (_name, usage, observed) => {
    const fake = fakeBilinc({ unmetered: true, usage });
    const report = await runGate({ bilinc: fake.bilinc, runId: 'ru2', sleep: fake.sleep, log: quiet, readUsage: fake.readUsage });
    expect(failedIds(report)).toEqual(['credits.unit-costs']);
    expect(report.results.find((result) => result.id === 'credits.unit-costs')?.detail).toContain(observed);
  });

  it('fails credits.unit-costs, without the key, when the status read fails on an unmetered plan', async () => {
    const fake = fakeBilinc({ unmetered: true });
    const lines: string[] = [];
    const report = await runGate({
      bilinc: fake.bilinc,
      runId: 'ru3',
      sleep: fake.sleep,
      log: (line) => lines.push(line),
      readUsage: () => Promise.reject(new TypeError('fetch failed for Bearer bil_live_abc123XYZ')),
    });
    expect(failedIds(report)).toEqual(['credits.unit-costs']);
    expect(JSON.stringify(report)).not.toContain('bil_live_abc123XYZ');
    expect(lines.join('\n')).not.toContain('bil_live_abc123XYZ');
  });

  it('takes every metered call cost from DOCUMENTED_UNIT_COSTS: no measured() call names a numeric cost', () => {
    const source = readFileSync(fileURLToPath(new URL('../scripts/gate.mjs', import.meta.url)), 'utf8');
    const calls = [...source.matchAll(/\bmeasured\(\s*'[^']+',\s*([^,]+),/g)].map((match) => match[1]?.trim());
    expect(calls.length).toBeGreaterThan(15);
    expect(calls.filter((cost) => !/^(null|'(memory_write|recall|snapshot|rollback)')$/.test(cost ?? ''))).toEqual([]);
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

describe('readStatusUsage', () => {
  const key = 'bil_live_abc123XYZ';

  it('sends one GET of /api/cloud/status with the Bearer key and returns usage', async () => {
    const stub = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ credits: { availableTotalCredits: null }, usage: LIVE_USAGE }),
    );
    const usage = await readStatusUsage({ baseUrl: 'https://bilinc.example', apiKey: key, fetch: stub });
    expect(usage).toEqual(LIVE_USAGE);
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] ?? [];
    expect(url).toBe('https://bilinc.example/api/cloud/status');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${key}`);
  });

  it('fails by status or error name only, never with the key', async () => {
    const refused = readStatusUsage({ baseUrl: 'https://bilinc.example', apiKey: key, fetch: async () => new Response('no', { status: 401 }) });
    await expect(refused).rejects.toThrow('GET /api/cloud/status answered 401');
    const broken = readStatusUsage({
      baseUrl: 'https://bilinc.example',
      apiKey: key,
      fetch: async () => Promise.reject(new TypeError(`fetch failed with ${key}`)),
    });
    await expect(broken).rejects.toThrow('GET /api/cloud/status failed: TypeError');
    await broken.catch((error: unknown) => expect(String(error)).not.toContain(key));
  });
});

describe('writeReport', () => {
  it.runIf(process.platform !== 'win32')('leaves the report readable by its owner only, also when it replaces an existing world-readable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-report-'));
    try {
      const fresh = join(dir, 'new.json');
      writeReport(fresh, { ok: true });
      expect(statSync(fresh).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(fresh, 'utf8'))).toEqual({ ok: true });

      const existing = join(dir, 'existing.json');
      writeFileSync(existing, 'old', { mode: 0o644 });
      expect(statSync(existing).mode & 0o777).toBe(0o644);
      writeReport(existing, { ok: false });
      expect(statSync(existing).mode & 0o777).toBe(0o600);
      expect(readFileSync(existing, 'utf8')).toBe(`${JSON.stringify({ ok: false }, null, 2)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
