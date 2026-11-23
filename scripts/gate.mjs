/* global console, process, setTimeout */
// Pre-publish gate for bilinc-cloudflare-agents (spec: "Unverified > Checked at the pre-publish gate": G5, G6, G7, G10).
// G5 includes the deployed sidecar version: the status.runtime-version check prints it and stores it in the report.
// Runs every BilincClient call against production Bilinc with a key from a DEDICATED test account.
// It spends about 11 credits on that account and runs a project-wide rollback, so it refuses a project that already holds entries,
// or a checkpoint that an earlier gate run did not make. A run that ends early forgets the keys it wrote (best effort).
// Usage: BILINC_GATE_API_KEY=... node scripts/gate.mjs <report.json> [--wait-expiry] [--allow-nonempty]
import { randomBytes } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GATE_NAMESPACE = 'gate';
export const TOKEN_TTL_MS = 300_000;
export const EXPIRY_WAIT_MS = 301_000;
export const CREDIT_SETTLE_ATTEMPTS = 4;
export const CREDIT_SETTLE_DELAY_MS = 1_500;

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SNAPSHOT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
// Every run leaves one checkpoint labelled with this prefix: Bilinc has no call that deletes a checkpoint.
const CHECKPOINT_LABEL_PREFIX = 'gate: before change ';
const SNAPSHOT_LIST_MAX = 100;
const CAPABILITIES = ['commit', 'recall', 'forget', 'snapshots', 'diff', 'rollback', 'history', 'list'];

export function randomAlnum(length) {
  let out = '';
  for (const byte of randomBytes(length)) out += ALNUM[byte % ALNUM.length];
  return out;
}

// Secret-shaped text is built at run time, so no token-shaped literal is ever committed.
export function secretSamples() {
  return {
    assignment: `gate note: password=${randomAlnum(16)}`,
    providerShaped: `gate note: ghp_${randomAlnum(36)}`,
  };
}

// Key names only: a recorded shape never holds a stored value, a token or the API key.
export function shapeOf(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { keys: [], itemKeys: {} };
  const keys = Object.keys(body).sort();
  const itemKeys = {};
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) {
      if (value.length > 0 && value[0] !== null && typeof value[0] === 'object') itemKeys[key] = Object.keys(value[0]).sort();
    } else if (value !== null && typeof value === 'object') {
      itemKeys[key] = Object.keys(value).sort();
    }
  }
  return { keys, itemKeys };
}

export function installShapeRecorder(target = globalThis) {
  const original = target.fetch;
  const shapes = [];
  target.fetch = async (input, init) => {
    const response = await original(input, init);
    const isRequest = typeof input === 'object' && input !== null && 'url' in input;
    const url = isRequest ? input.url : String(input);
    const method = init?.method ?? (isRequest ? input.method : 'GET');
    let shape;
    try {
      shape = shapeOf(await response.clone().json());
    } catch {
      shape = null;
    }
    shapes.push({ method, path: url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[?#].*$/, ''), status: response.status, shape });
    return response;
  };
  return {
    shapes,
    restore() {
      target.fetch = original;
    },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultLog(line) {
  console.log(line);
}

function isError(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string';
}

function describeError(error) {
  return isError(error) ? `${error.code} ${error.status}` : 'no error';
}

// Code and status for a Bilinc error; otherwise name and a bounded message with token-shaped text removed. Never a stack.
export function abortDetail(error) {
  if (isError(error)) return describeError(error);
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message.replace(/\bbil_[A-Za-z0-9_-]+/g, '[redacted]').replace(/\s+/g, ' ').slice(0, 200)}`;
}

export async function runGate({ bilinc, runId, sleep = defaultSleep, log = defaultLog, waitForExpiry = false, allowNonEmpty = false }) {
  const { client, prefix } = bilinc;
  const results = [];
  let expectedTotal = 0;

  const check = (id, item, ok, detail) => {
    results.push({ id, item, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${item} ${id} (${detail})`);
  };
  // Keys this run may have written. A key leaves the set once the run's own rollback or forget removed it;
  // whatever is left when the run ends (an early return, a throw, a failed rollback or forget) is forgotten by cleanUp().
  const leftover = new Set();
  // Best effort, never throws: a failure is recorded in the cleanup check. Runs only when keys are left.
  const cleanUp = async () => {
    if (leftover.size === 0) return;
    let removed = 0;
    const stillThere = [];
    for (const key of leftover) {
      try {
        // removed:false means there was nothing to remove: neither forgotten by this cleanup nor still there.
        const result = await client.forget({ key, reason: `gate: cleanup ${runId}` });
        if (result?.removed === true) removed += 1;
      } catch (error) {
        if (!(isError(error) && error.code === 'memory_not_found')) stillThere.push(`${key} (${abortDetail(error)})`);
      }
    }
    try {
      check(
        'cleanup',
        'gate',
        stillThere.length === 0,
        `forgot ${removed} keys this run left behind` + (stillThere.length > 0 ? `; still there: ${stillThere.join(', ')}` : ''),
      );
    } catch {
      // A throwing log must not turn cleanup into a throw.
    }
  };
  // Every exit goes through finish(), so cleanup runs before ok is computed.
  const finish = async () => {
    await cleanUp();
    return { ok: results.every((result) => result.ok), results };
  };
  const expectError = (id, item, error, code, status) => {
    const ok =
      isError(error) && error.code === code && error.status === status && typeof error.requestId === 'string' && error.requestId.length > 0;
    check(id, item, ok, `got ${describeError(error)}, expected ${code} ${status}`);
  };
  const credits = async () => {
    const status = await client.status();
    const value = status.credits?.availableTotalCredits;
    if (typeof value !== 'number') throw new Error('status.credits.availableTotalCredits is not a number');
    return value;
  };
  const measured = async (id, cost, call) => {
    expectedTotal += cost;
    const before = await credits();
    let value;
    let error;
    try {
      value = await call();
    } catch (caught) {
      error = caught;
    }
    let after = await credits();
    for (let attempt = 1; attempt < CREDIT_SETTLE_ATTEMPTS && before - after !== cost; attempt += 1) {
      await sleep(CREDIT_SETTLE_DELAY_MS);
      after = await credits();
    }
    check(`credits.${id}`, 'G10', before - after === cost, `spent ${before - after}, expected ${cost}`);
    return { value, error };
  };

  try {
    const project = await client.list({ limit: 1 });
    check('project.empty', 'gate', project.total === 0 || allowNonEmpty, `${project.total} entries in the project`);
    if (project.total > 0 && !allowNonEmpty) return finish();

    const startCredits = await credits();
    const status = await client.status();
    check(
      'status.capabilities',
      'G5',
      CAPABILITIES.every((name) => status.capabilities[name] === true),
      CAPABILITIES.map((name) => `${name}=${String(status.capabilities[name])}`).join(' '),
    );
    check(
      'status.runtime-version',
      'G5',
      typeof status.runtimeVersion === 'string' && status.runtimeVersion.length > 0,
      `sidecar runtime ${String(status.runtimeVersion)}`,
    );
    check('status.recallProfiles', 'G5', ['fast', 'balanced'].every((profile) => status.recallProfiles.includes(profile)), status.recallProfiles.join(','));
    if (!allowNonEmpty) {
      const existing = await client.listSnapshots({ limit: SNAPSHOT_LIST_MAX });
      const earlier = existing.filter((snapshot) => snapshot.label?.startsWith(CHECKPOINT_LABEL_PREFIX) === true).length;
      const other = existing.length - earlier;
      // The list is newest first with no cursor, so a full list hides anything older than the newest 100.
      // A full list made only of gate checkpoints passes; the detail says the older ones were not checked.
      const full = existing.length >= SNAPSHOT_LIST_MAX;
      check(
        'snapshots.empty',
        'G6',
        other === 0,
        `${other} other checkpoints before the run, ${earlier} from earlier gate runs` +
          (full ? '; the list is full, so older checkpoints were not checked' : ''),
      );
      if (other > 0) return finish();
    }

    const fact = `${prefix}gate-${runId}-fact`;
    const redactedKey = `${prefix}gate-${runId}-redacted`;
    const refusedKey = `${prefix}gate-${runId}-refused`;
    const otherKey = `cf.${GATE_NAMESPACE}b.gate-${runId}-other`;
    const sessionId = `gate-${runId}`;
    const commit = async (key, value, namespace = GATE_NAMESPACE) => {
      // Added before the call: a commit that fails without a definite answer may still have been applied.
      const addedNow = !leftover.has(key);
      leftover.add(key);
      try {
        return await client.commit({ key, value, source: 'cloudflare-agent', sessionId, metadata: { agentId: 'gate', namespace } });
      } catch (error) {
        // A definite refusal wrote nothing, so a key this call added is not left behind. A key written
        // earlier in the run stays, and so does one whose failure is not a definite Bilinc answer.
        if (addedNow && isError(error) && error.outcomeUnknown === false) leftover.delete(key);
        throw error;
      }
    };

    const listed = await measured('list', 0, () => client.list({ prefix, order: 'newest', values: 'none', limit: 10 }));
    check('list.order-newest', 'G5', listed.error === undefined, describeError(listed.error));

    const first = await measured('commit', 1, () => commit(fact, 'The gate test colour is blue.'));
    check(
      'commit.shape',
      'G6',
      first.error === undefined && typeof first.value.entryVersion === 'string' && first.value.affectedKeys.includes(fact),
      first.error === undefined ? `entryVersion ${String(first.value.entryVersion)}` : describeError(first.error),
    );

    const label = `${CHECKPOINT_LABEL_PREFIX}${runId}`;
    const created = await measured('createSnapshot', 2, () => client.createSnapshot({ label }));
    const snapshotId = created.value?.id;
    check(
      'createSnapshot.shape',
      'G6',
      typeof snapshotId === 'string' && SNAPSHOT_ID_RE.test(snapshotId) && created.value.label === label,
      created.error === undefined ? `id ${String(snapshotId)}` : describeError(created.error),
    );
    if (typeof snapshotId !== 'string') return finish();

    const listedSnapshots = await measured('listSnapshots', 0, () => client.listSnapshots({ limit: 20 }));
    const newest = listedSnapshots.value?.[0];
    check(
      'listSnapshots.newest-first',
      'G6',
      newest !== undefined &&
        newest.id === snapshotId &&
        newest.label === label &&
        !Number.isNaN(Date.parse(newest.createdAt)) &&
        typeof newest.totalEntries === 'number',
      listedSnapshots.error === undefined ? `newest ${String(newest?.id)}` : describeError(listedSnapshots.error),
    );

    const second = await measured('commit.upsert', 1, () => commit(fact, 'The gate test colour is red.'));
    check('commit.upsert.accepted', 'G7', second.error === undefined, describeError(second.error));
    const history = await measured('history', 0, () => client.history({ key: fact, values: 'preview', limit: 20 }));
    check(
      'commit.upsert.history',
      'G7',
      history.error === undefined && history.value.exists === true && history.value.entries.length >= 2,
      history.error === undefined ? `${history.value.entries.length} versions` : describeError(history.error),
    );
    const afterUpsert = await measured('list.after-upsert', 0, () => client.list({ prefix, order: 'newest', values: 'none', limit: 10 }));
    check(
      'commit.upsert.total',
      'G7',
      afterUpsert.error === undefined &&
        afterUpsert.value.entries.filter((entry) => entry.key === fact).length === 1 &&
        afterUpsert.value.total === (listed.value?.total ?? 0) + 1,
      afterUpsert.error === undefined ? `total ${afterUpsert.value.total}` : describeError(afterUpsert.error),
    );

    const recalled = await measured('recall', 1, () => client.recall({ query: 'gate test colour', profile: 'balanced', limit: 20 }));
    const hit = recalled.value?.find((candidate) => candidate.key === fact);
    check(
      'recall.shape',
      'G6',
      hit !== undefined &&
        hit.value.includes('red') &&
        typeof hit.entryVersion === 'string' &&
        typeof hit.updatedAt === 'string' &&
        !Number.isNaN(Date.parse(hit.updatedAt)),
      recalled.error !== undefined
        ? describeError(recalled.error)
        : hit === undefined
          ? `${recalled.value.length} hits, none for the committed key`
          : 'hit for the committed key',
    );

    const diffed = await measured('diff', 0, () => client.diff({ fromSnapshotId: snapshotId, includeValues: false, limit: 100 }));
    check(
      'diff.shape',
      'G6',
      diffed.error === undefined && diffed.value.modified.includes(fact) && diffed.value.counts.modified >= 1,
      diffed.error === undefined ? `counts ${JSON.stringify(diffed.value.counts)}` : describeError(diffed.error),
    );

    const samples = secretSamples();
    const redacted = await measured('commit.secret-redacted', 1, () => commit(redactedKey, samples.assignment));
    check(
      'secret_scan.redacted',
      'G5',
      redacted.error === undefined && redacted.value.warnings.some((warning) => warning.code === 'secret_redacted'),
      redacted.error === undefined ? `${redacted.value.warnings.length} warnings` : describeError(redacted.error),
    );
    const refused = await measured('commit.secret-detected', 0, () => commit(refusedKey, samples.providerShaped));
    expectError('secret_scan.detected', 'G5', refused.error, 'secret_detected', 422);

    const missing = await measured('diff.unknown-checkpoint', 0, () =>
      client.diff({ fromSnapshotId: `gate-missing-${runId}`, includeValues: false, limit: 10 }),
    );
    expectError('error-body.snapshot_not_found', 'G10', missing.error, 'snapshot_not_found', 404);

    await measured('commit.other-namespace', 1, () => commit(otherKey, 'Outside the gate namespace.', `${GATE_NAMESPACE}b`));
    const reason = `gate: restore ${runId}`;
    const preview = await measured('rollbackPreview', 0, () => client.rollbackPreview({ snapshotId, reason, limit: 100 }));
    const planned = preview.value;
    check(
      'preview.project-wide',
      'G10',
      planned !== undefined &&
        planned.removeKeys.includes(otherKey) &&
        planned.removeKeys.includes(redactedKey) &&
        planned.updateKeys.includes(fact) &&
        planned.counts.remove >= 2 &&
        planned.counts.update >= 1,
      planned === undefined ? describeError(preview.error) : `counts ${JSON.stringify(planned.counts)}`,
    );
    if (planned === undefined) return finish();
    const ttl = Date.parse(planned.confirmationExpiresAt) - Date.now();
    check(
      'preview.token-ttl',
      'G10',
      planned.confirmationToken.length > 0 && ttl > TOKEN_TTL_MS - 60_000 && ttl <= TOKEN_TTL_MS + 5_000,
      `expires in ${Math.round(ttl / 1000)} s`,
    );

    const rolled = await measured('rollback', 2, () => client.rollback({ snapshotId, reason, confirmationToken: planned.confirmationToken }));
    check(
      'rollback.execute',
      'G10',
      rolled.error === undefined && rolled.value.snapshotId === snapshotId && rolled.value.counts.deleted >= 2 && rolled.value.counts.updated >= 1,
      rolled.error === undefined ? `counts ${JSON.stringify(rolled.value.counts)}` : describeError(rolled.error),
    );
    const replay = await measured('rollback.reused-token', 0, () =>
      client.rollback({ snapshotId, reason, confirmationToken: planned.confirmationToken }),
    );
    expectError('token.single-use', 'G10', replay.error, 'state_changed_since_preview', 409);
    const restored = await measured('diff.after-rollback', 0, () => client.diff({ fromSnapshotId: snapshotId, includeValues: false, limit: 100 }));
    const runKeys =
      restored.error === undefined
        ? [...restored.value.added, ...restored.value.modified, ...restored.value.removed].filter((key) => key.includes(`gate-${runId}-`))
        : [];
    const restoredOk = restored.error === undefined && runKeys.length === 0;
    check(
      'rollback.restored',
      'G10',
      restoredOk,
      restored.error === undefined ? `${runKeys.length} keys of this run still differ` : describeError(restored.error),
    );
    // The rollback removed every key written after the checkpoint; only the fact, which the checkpoint holds, is left.
    if (restoredOk) for (const key of [redactedKey, refusedKey, otherKey]) leftover.delete(key);

    if (waitForExpiry) {
      await measured('commit.expiry-setup', 1, () => commit(fact, 'The gate test colour is green.'));
      const lateReason = `gate: expiry ${runId}`;
      const late = await measured('rollbackPreview.expiry', 0, () => client.rollbackPreview({ snapshotId, reason: lateReason, limit: 10 }));
      if (late.value === undefined) {
        check('token.expires-300s', 'G10', false, `preview failed: ${describeError(late.error)}`);
      } else {
        log(`waiting ${Math.round(EXPIRY_WAIT_MS / 1000)} s for the preview token to expire`);
        await sleep(EXPIRY_WAIT_MS);
        const expired = await measured('rollback.expired-token', 0, () =>
          client.rollback({ snapshotId, reason: lateReason, confirmationToken: late.value.confirmationToken }),
        );
        expectError('token.expires-300s', 'G10', expired.error, 'rollback_confirmation_expired', 410);
      }
    }

    const forgotten = await measured('forget', 1, () => client.forget({ key: fact, reason: `gate: cleanup ${runId}` }));
    const forgotOk = forgotten.error === undefined && forgotten.value.removed === true && forgotten.value.key === fact;
    check('forget.removed', 'G10', forgotOk, describeError(forgotten.error));
    if (forgotOk) leftover.delete(fact);

    const endCredits = await credits();
    check('credits.total', 'G10', startCredits - endCredits === expectedTotal, `spent ${startCredits - endCredits}, expected ${expectedTotal}`);
    return finish();
  } catch (error) {
    // Keep every check made so far: the report is still written, and it fails.
    check('aborted', 'gate', false, abortDetail(error));
    return finish();
  }
}

async function main(argv) {
  const apiKey = process.env.BILINC_GATE_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    console.error('BILINC_GATE_API_KEY is not set. Use a key from a dedicated Bilinc test account.');
    process.exitCode = 2;
    return;
  }
  const reportPath = argv.find((arg) => !arg.startsWith('--'));
  if (reportPath === undefined) {
    console.error('usage: node scripts/gate.mjs <report.json> [--wait-expiry] [--allow-nonempty]');
    process.exitCode = 2;
    return;
  }
  const recorder = installShapeRecorder();
  const { createBilinc } = await import('../dist/index.js');
  const runId = Date.now().toString(36);
  const bilinc = createBilinc({ apiKey, namespace: GATE_NAMESPACE, agentId: 'gate', sessionId: `gate-${runId}`, onError: () => undefined });
  let report;
  try {
    report = await runGate({
      bilinc,
      runId,
      waitForExpiry: argv.includes('--wait-expiry'),
      allowNonEmpty: argv.includes('--allow-nonempty'),
    });
  } finally {
    recorder.restore();
  }
  const body = { runId, finishedAt: new Date().toISOString(), ok: report.ok, results: report.results, shapes: recorder.shapes };
  writeFileSync(reportPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  const failed = report.results.filter((result) => !result.ok).map((result) => result.id);
  console.log(failed.length === 0 ? `GATE PASS (${report.results.length} checks)` : `GATE FAIL: ${failed.join(', ')}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

function invokedDirectly() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main(process.argv.slice(2));
