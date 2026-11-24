/* global AbortSignal, console, fetch, process, setTimeout */
// Pre-publish gate for bilinc-cloudflare-agents (spec: "Unverified > Checked at the pre-publish gate": G5, G6, G7, G10).
// G5 includes the deployed sidecar version: status.runtime-version checks it when /api/cloud/status reports one; today it does not,
// so it is only a note in the report (notes) and GATE.md records the version read on the server.
// Runs every BilincClient call against production Bilinc with a key from a DEDICATED test account.
// It spends about 11 credits on that account and runs a project-wide rollback, so it refuses a project that already holds entries,
// or a checkpoint that an earlier gate run did not make. A run that ends early forgets the keys it wrote (best effort).
// Metered and unmetered plans are both supported. The status read at the start of the run decides which; the report's mode
// field and a NOTE log line record it (it is not a check):
// - metered (a numeric credits.availableTotalCredits, e.g. the Free plan): each call's cost is measured by the balance delta
//   (credits.<call> checks) and the run's total by credits.total;
// - unmetered (the raw status body has credits.availableTotalCredits: null): calls are not measured by balance delta, and no
//   credits.<call> or credits.total check is made. credits.unit-costs compares status
//   usage[].creditsEach with the documented unit costs. Usage counters are per organisation, so other projects can only add to
//   them: credits.usage-lower-bound checks that each documented event type's usage[].used grew by at least this run's billed
//   calls of that type, and says that upper bounds and "free calls stay free" cannot be verified this way.
//   The package client's status() does not expose usage and maps a missing or non-number balance to null, so the gate reads the
//   raw credits and usage with a GET of /api/cloud/status with the same key (at the start, and at the end of an unmetered run);
//   the key is never logged or stored.
// - anything else (credits missing or null, the balance missing, or a value that is neither a number nor null): credits.mode fails
//   and the run stops before it spends anything.
// Usage: BILINC_GATE_API_KEY=... node scripts/gate.mjs <report.json> [--wait-expiry] [--allow-nonempty]
import { randomBytes } from 'node:crypto';
import { chmodSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GATE_NAMESPACE = 'gate';
export const TOKEN_TTL_MS = 300_000;
export const EXPIRY_WAIT_MS = 301_000;
export const CREDIT_SETTLE_ATTEMPTS = 4;
export const CREDIT_SETTLE_DELAY_MS = 1_500;
export const GATE_BASE_URL = 'https://bilinc.space';
// Credits per event as the package documents them: the one source of the metered per-call costs,
// and what credits.unit-costs checks status usage[].creditsEach against.
export const DOCUMENTED_UNIT_COSTS = Object.freeze({ memory_write: 1, recall: 1, snapshot: 2, rollback: 2 });
const STATUS_READ_TIMEOUT_MS = 15_000;

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

// writeFileSync's mode applies only when it creates the file, so an existing report would keep its old,
// possibly world-readable mode. A fresh file made only for this write, then renamed over the path, never does.
// A symlink at the path is replaced, never followed, so the gate cannot be steered into overwriting another file.
export function writeReport(reportPath, body) {
  const temp = `${reportPath}.${randomAlnum(12)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    renameSync(temp, reportPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// One raw GET of <baseUrl>/api/cloud/status with the gate's key. Resolves to the body's raw credits and usage[]: the package
// client's status() drops usage and maps a missing or non-number balance to null, so only the raw body tells them apart.
// A credits or usage field the body does not have is undefined (JSON has no undefined, so undefined means missing).
// A failure names only the HTTP status or the error's name: never the message, URL or headers, so never the key.
export async function readStatusUsage({ baseUrl, apiKey, fetch: fetchImpl = (...args) => fetch(...args) }) {
  // No `cause` on the thrown error on purpose: the original error's message could hold the key.
  const errorName = (error) => (error instanceof Error ? error.name : 'Error');
  let response;
  let failure;
  try {
    response = await fetchImpl(`${baseUrl}/api/cloud/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS),
    });
  } catch (error) {
    failure = errorName(error);
  }
  if (failure !== undefined) throw new Error(`GET /api/cloud/status failed: ${failure}`);
  if (response.status < 200 || response.status >= 300) throw new Error(`GET /api/cloud/status answered ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch (error) {
    failure = errorName(error);
  }
  if (failure !== undefined) throw new Error(`GET /api/cloud/status failed: ${failure}`);
  return body !== null && typeof body === 'object' ? { credits: body.credits, usage: body.usage } : { credits: undefined, usage: undefined };
}

const kindOf = (value) => {
  const kind = Array.isArray(value) ? 'array' : typeof value;
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;
};

// Why a raw status read does not show an unmetered plan, or undefined when it does. Only an object credits whose
// availableTotalCredits is null marks one; a missing field or another value is not read as "no limit". Names types, never values.
function notUnmetered(raw) {
  const rawCredits = raw !== null && typeof raw === 'object' ? raw.credits : undefined;
  if (rawCredits === null || typeof rawCredits !== 'object' || Array.isArray(rawCredits)) return 'status.credits is missing or not an object';
  if (!Object.hasOwn(rawCredits, 'availableTotalCredits')) return 'status.credits.availableTotalCredits is missing';
  const value = rawCredits.availableTotalCredits;
  return value === null ? undefined : `status.credits.availableTotalCredits is ${kindOf(value)}`;
}

// creditsEach per documented event type, or 'missing'. Only a number counts.
function unitCosts(usage) {
  const rows = Array.isArray(usage) ? usage.filter((row) => row !== null && typeof row === 'object') : [];
  return Object.keys(DOCUMENTED_UNIT_COSTS).map((eventType) => {
    const each = rows.find((row) => row.eventType === eventType)?.creditsEach;
    return { eventType, observed: typeof each === 'number' ? each : 'missing' };
  });
}

// usage[].used of one event type, or undefined when the row or a numeric used is missing.
function usedOf(usage, eventType) {
  const rows = Array.isArray(usage) ? usage.filter((row) => row !== null && typeof row === 'object') : [];
  const used = rows.find((row) => row.eventType === eventType)?.used;
  return typeof used === 'number' && Number.isFinite(used) ? used : undefined;
}

export async function runGate({
  bilinc,
  runId,
  sleep = defaultSleep,
  log = defaultLog,
  waitForExpiry = false,
  allowNonEmpty = false,
  readUsage,
}) {
  const { client, prefix } = bilinc;
  const results = [];
  let expectedTotal = 0;
  // Billed calls of this run per usage event type, counted by measured(); the unmetered usage lower bound compares against it.
  const billedCalls = Object.fromEntries(Object.keys(DOCUMENTED_UNIT_COSTS).map((eventType) => [eventType, 0]));
  // usage[] of the raw status read at the start of an unmetered run.
  let startUsage;
  // Set by the status read at the start of the run: an unmetered plan has no balance to measure calls against.
  let unmetered = false;

  const check = (id, item, ok, detail) => {
    results.push({ id, item, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${item} ${id} (${detail})`);
  };
  // Informational: written to the report's notes and the log, never a check, so it can neither pass nor fail the run.
  const notes = [];
  const note = (id, item, detail) => {
    notes.push({ id, item, detail });
    log(`NOTE ${item} ${id} (${detail})`);
  };
  // 'metered' | 'unmetered', set once the status read at the start decides it; undefined when the run stops before that.
  let mode;
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
    return { ok: results.every((result) => result.ok), mode, notes, results };
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
  // eventType is the billed usage event of a call (a DOCUMENTED_UNIT_COSTS key; forget is a memory_write), or null for a free call.
  const measured = async (id, eventType, call) => {
    if (eventType !== null && !Object.hasOwn(DOCUMENTED_UNIT_COSTS, eventType)) throw new Error(`unknown usage event type ${eventType}`);
    const cost = eventType === null ? 0 : DOCUMENTED_UNIT_COSTS[eventType];
    // The same bookkeeping on both plans: the metered total and the unmetered usage lower bound cannot drift apart.
    expectedTotal += cost;
    if (eventType !== null) billedCalls[eventType] += 1;
    if (unmetered) {
      try {
        return { value: await call(), error: undefined };
      } catch (caught) {
        return { value: undefined, error: caught };
      }
    }
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

    const status = await client.status();
    // A numeric balance is metered. Anything else is unmetered only when the raw body says credits.availableTotalCredits: null;
    // the client maps a missing or non-number balance to null too, so the run stops on anything else before it spends.
    unmetered = typeof status.credits?.availableTotalCredits !== 'number';
    const startCredits = unmetered ? undefined : await credits();
    if (!unmetered) {
      mode = 'metered';
      note('credits.mode', 'G10', 'metered: each call is measured by the balance delta');
    }
    if (unmetered) {
      const stop = 'only credits.availableTotalCredits: null marks an unmetered plan, so the run stopped before spending anything';
      if (status.credits === null) {
        check('credits.mode', 'G10', false, `status.credits is missing or not an object; ${stop}`);
        return finish();
      }
      if (typeof readUsage !== 'function') {
        check('credits.mode', 'G10', false, `status reports no numeric balance and no raw status read was given to tell null from missing; ${stop}`);
        return finish();
      }
      let raw;
      try {
        raw = await readUsage();
      } catch (error) {
        check('credits.mode', 'G10', false, `could not read the raw status: ${abortDetail(error)}; ${stop}`);
        return finish();
      }
      const reason = notUnmetered(raw);
      if (reason !== undefined) {
        check('credits.mode', 'G10', false, `${reason}; ${stop}`);
        return finish();
      }
      mode = 'unmetered';
      note('credits.mode', 'G10', 'unmetered: the plan has no credit balance, so per-call costs were not measured by balance delta');
      startUsage = raw.usage;
      const costs = unitCosts(startUsage);
      const list = (pairs) => pairs.map(([eventType, each]) => `${eventType}=${each}`).join(' ');
      check(
        'credits.unit-costs',
        'G10',
        costs.every(({ eventType, observed }) => observed === DOCUMENTED_UNIT_COSTS[eventType]),
        `status usage creditsEach ${list(costs.map(({ eventType, observed }) => [eventType, observed]))}; ` +
          `documented ${list(Object.entries(DOCUMENTED_UNIT_COSTS))}`,
      );
    }
    check(
      'status.capabilities',
      'G5',
      CAPABILITIES.every((name) => status.capabilities[name] === true),
      CAPABILITIES.map((name) => `${name}=${String(status.capabilities[name])}`).join(' '),
    );
    if (typeof status.runtimeVersion === 'string' && status.runtimeVersion.length > 0) {
      check('status.runtime-version', 'G5', true, `sidecar runtime ${status.runtimeVersion}`);
    } else {
      // /api/cloud/status reports only runtime "ready" | "unavailable" today, so a missing version is a note, not a check;
      // the deployed sidecar version is then read on the server and written into GATE.md.
      note('status.runtime-version', 'G5', 'sidecar runtime not reported by /api/cloud/status; record the deployed version from the server in GATE.md');
    }
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

    const listed = await measured('list', null, () => client.list({ prefix, order: 'newest', values: 'none', limit: 10 }));
    check('list.order-newest', 'G5', listed.error === undefined, describeError(listed.error));

    const first = await measured('commit', 'memory_write', () => commit(fact, 'The gate test colour is blue.'));
    check(
      'commit.shape',
      'G6',
      first.error === undefined && typeof first.value.entryVersion === 'string' && first.value.affectedKeys.includes(fact),
      first.error === undefined ? `entryVersion ${String(first.value.entryVersion)}` : describeError(first.error),
    );

    const label = `${CHECKPOINT_LABEL_PREFIX}${runId}`;
    const created = await measured('createSnapshot', 'snapshot', () => client.createSnapshot({ label }));
    const snapshotId = created.value?.id;
    check(
      'createSnapshot.shape',
      'G6',
      typeof snapshotId === 'string' && SNAPSHOT_ID_RE.test(snapshotId) && created.value.label === label,
      created.error === undefined ? `id ${String(snapshotId)}` : describeError(created.error),
    );
    if (typeof snapshotId !== 'string') return finish();

    const listedSnapshots = await measured('listSnapshots', null, () => client.listSnapshots({ limit: 20 }));
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

    const second = await measured('commit.upsert', 'memory_write', () => commit(fact, 'The gate test colour is red.'));
    check('commit.upsert.accepted', 'G7', second.error === undefined, describeError(second.error));
    const history = await measured('history', null, () => client.history({ key: fact, values: 'preview', limit: 20 }));
    check(
      'commit.upsert.history',
      'G7',
      history.error === undefined && history.value.exists === true && history.value.entries.length >= 2,
      history.error === undefined ? `${history.value.entries.length} versions` : describeError(history.error),
    );
    const afterUpsert = await measured('list.after-upsert', null, () => client.list({ prefix, order: 'newest', values: 'none', limit: 10 }));
    check(
      'commit.upsert.total',
      'G7',
      afterUpsert.error === undefined &&
        afterUpsert.value.entries.filter((entry) => entry.key === fact).length === 1 &&
        afterUpsert.value.total === (listed.value?.total ?? 0) + 1,
      afterUpsert.error === undefined ? `total ${afterUpsert.value.total}` : describeError(afterUpsert.error),
    );

    const recalled = await measured('recall', 'recall', () => client.recall({ query: 'gate test colour', profile: 'balanced', limit: 20 }));
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

    const diffed = await measured('diff', null, () => client.diff({ fromSnapshotId: snapshotId, includeValues: false, limit: 100 }));
    check(
      'diff.shape',
      'G6',
      diffed.error === undefined && diffed.value.modified.includes(fact) && diffed.value.counts.modified >= 1,
      diffed.error === undefined ? `counts ${JSON.stringify(diffed.value.counts)}` : describeError(diffed.error),
    );

    const samples = secretSamples();
    const redacted = await measured('commit.secret-redacted', 'memory_write', () => commit(redactedKey, samples.assignment));
    check(
      'secret_scan.redacted',
      'G5',
      redacted.error === undefined && redacted.value.warnings.some((warning) => warning.code === 'secret_redacted'),
      redacted.error === undefined ? `${redacted.value.warnings.length} warnings` : describeError(redacted.error),
    );
    const refused = await measured('commit.secret-detected', null, () => commit(refusedKey, samples.providerShaped));
    expectError('secret_scan.detected', 'G5', refused.error, 'secret_detected', 422);

    const missing = await measured('diff.unknown-checkpoint', null, () =>
      client.diff({ fromSnapshotId: `gate-missing-${runId}`, includeValues: false, limit: 10 }),
    );
    expectError('error-body.snapshot_not_found', 'G10', missing.error, 'snapshot_not_found', 404);

    await measured('commit.other-namespace', 'memory_write', () => commit(otherKey, 'Outside the gate namespace.', `${GATE_NAMESPACE}b`));
    const reason = `gate: restore ${runId}`;
    const preview = await measured('rollbackPreview', null, () => client.rollbackPreview({ snapshotId, reason, limit: 100 }));
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

    const rolled = await measured('rollback', 'rollback', () => client.rollback({ snapshotId, reason, confirmationToken: planned.confirmationToken }));
    check(
      'rollback.execute',
      'G10',
      rolled.error === undefined && rolled.value.snapshotId === snapshotId && rolled.value.counts.deleted >= 2 && rolled.value.counts.updated >= 1,
      rolled.error === undefined ? `counts ${JSON.stringify(rolled.value.counts)}` : describeError(rolled.error),
    );
    const replay = await measured('rollback.reused-token', null, () =>
      client.rollback({ snapshotId, reason, confirmationToken: planned.confirmationToken }),
    );
    expectError('token.single-use', 'G10', replay.error, 'state_changed_since_preview', 409);
    const restored = await measured('diff.after-rollback', null, () => client.diff({ fromSnapshotId: snapshotId, includeValues: false, limit: 100 }));
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
      await measured('commit.expiry-setup', 'memory_write', () => commit(fact, 'The gate test colour is green.'));
      const lateReason = `gate: expiry ${runId}`;
      const late = await measured('rollbackPreview.expiry', null, () => client.rollbackPreview({ snapshotId, reason: lateReason, limit: 10 }));
      if (late.value === undefined) {
        check('token.expires-300s', 'G10', false, `preview failed: ${describeError(late.error)}`);
      } else {
        log(`waiting ${Math.round(EXPIRY_WAIT_MS / 1000)} s for the preview token to expire`);
        await sleep(EXPIRY_WAIT_MS);
        const expired = await measured('rollback.expired-token', null, () =>
          client.rollback({ snapshotId, reason: lateReason, confirmationToken: late.value.confirmationToken }),
        );
        expectError('token.expires-300s', 'G10', expired.error, 'rollback_confirmation_expired', 410);
      }
    }

    const forgotten = await measured('forget', 'memory_write', () => client.forget({ key: fact, reason: `gate: cleanup ${runId}` }));
    const forgotOk = forgotten.error === undefined && forgotten.value.removed === true && forgotten.value.key === fact;
    check('forget.removed', 'G10', forgotOk, describeError(forgotten.error));
    if (forgotOk) leftover.delete(fact);

    if (!unmetered) {
      const endCredits = await credits();
      check('credits.total', 'G10', startCredits - endCredits === expectedTotal, `spent ${startCredits - endCredits}, expected ${expectedTotal}`);
    } else {
      // Usage is counted per organisation: other projects can only add to it, so this is a lower bound on what the run billed.
      const caveat =
        'usage is counted per organisation, so other projects can only add to it: this is a lower bound only, and upper bounds ' +
        'and "free calls stay free" cannot be verified on an unmetered plan';
      let endUsage;
      let readFailure;
      try {
        endUsage = (await readUsage())?.usage;
      } catch (error) {
        readFailure = abortDetail(error);
      }
      if (readFailure !== undefined) {
        check('credits.usage-lower-bound', 'G10', false, `could not read status usage at the end: ${readFailure}; ${caveat}`);
      } else {
        const growth = Object.keys(DOCUMENTED_UNIT_COSTS).map((eventType) => {
          const before = usedOf(startUsage, eventType);
          const after = usedOf(endUsage, eventType);
          const expected = billedCalls[eventType];
          return before === undefined || after === undefined
            ? { ok: false, text: `${eventType} used missing (at least ${expected})` }
            : { ok: after - before >= expected, text: `${eventType} +${after - before} (at least ${expected})` };
        });
        check(
          'credits.usage-lower-bound',
          'G10',
          growth.every((row) => row.ok),
          `usage[].used grew ${growth.map((row) => row.text).join(', ')}; ${caveat}`,
        );
      }
    }
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
    console.error(
      'usage: node scripts/gate.mjs <report.json> [--wait-expiry] [--allow-nonempty]\n' +
        'Runs on metered and unmetered plans. On an unmetered plan (credits.availableTotalCredits: null) it checks the unit costs in\n' +
        'GET /api/cloud/status usage[].creditsEach instead of measuring each call by balance delta.',
    );
    process.exitCode = 2;
    return;
  }
  const recorder = installShapeRecorder();
  const { createBilinc } = await import('../dist/index.js');
  const runId = Date.now().toString(36);
  const bilinc = createBilinc({
    apiKey,
    baseUrl: GATE_BASE_URL,
    namespace: GATE_NAMESPACE,
    agentId: 'gate',
    sessionId: `gate-${runId}`,
    onError: () => undefined,
  });
  // Read only when status reports no numeric balance. Goes through globalThis.fetch at call time, so the shape recorder sees it (key names only).
  const readUsage = () => readStatusUsage({ baseUrl: GATE_BASE_URL, apiKey: apiKey.trim() });
  let report;
  try {
    report = await runGate({
      bilinc,
      runId,
      waitForExpiry: argv.includes('--wait-expiry'),
      allowNonEmpty: argv.includes('--allow-nonempty'),
      readUsage,
    });
  } finally {
    recorder.restore();
  }
  const body = {
    runId,
    finishedAt: new Date().toISOString(),
    ok: report.ok,
    mode: report.mode ?? null,
    notes: report.notes,
    results: report.results,
    shapes: recorder.shapes,
  };
  writeReport(reportPath, body);
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
