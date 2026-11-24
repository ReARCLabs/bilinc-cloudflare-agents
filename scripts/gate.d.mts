import type { BilincClient } from '../src/index';

export declare const GATE_NAMESPACE: 'gate';
export declare const TOKEN_TTL_MS: number;
export declare const EXPIRY_WAIT_MS: number;
export declare const CREDIT_SETTLE_ATTEMPTS: number;
export declare const CREDIT_SETTLE_DELAY_MS: number;
export declare const GATE_BASE_URL: string;
/** Credits per event as the package documents them; credits.unit-costs checks them against status usage[].creditsEach. */
export declare const DOCUMENTED_UNIT_COSTS: Readonly<{ memory_write: 1; recall: 1; snapshot: 2; rollback: 2 }>;

export interface GateCheck {
  id: string;
  item: string;
  ok: boolean;
  detail: string;
}

export interface GateReport {
  ok: boolean;
  results: GateCheck[];
}

export interface Shape {
  keys: string[];
  itemKeys: Record<string, string[]>;
}

export interface RecordedShape {
  method: string;
  path: string;
  status: number;
  shape: Shape | null;
}

export declare function randomAlnum(length: number): string;
export declare function secretSamples(): { assignment: string; providerShaped: string };
export declare function shapeOf(body: unknown): Shape;
export declare function installShapeRecorder(target?: { fetch: typeof fetch }): { shapes: RecordedShape[]; restore(): void };
/** Writes the report as JSON, readable by its owner only, also when a file is already at that path. A symlink at the path is replaced, not followed. */
export declare function writeReport(reportPath: string, body: unknown): void;
/**
 * One raw GET of `<baseUrl>/api/cloud/status` with the Bearer key; resolves to the body's `usage`, which the package client's
 * status() does not expose. A failure names only the HTTP status or the error's name, never the key.
 */
export declare function readStatusUsage(options: {
  baseUrl: string;
  apiKey: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<unknown>;
/**
 * On an unmetered plan (status reports no numeric credits.availableTotalCredits) calls are not measured by balance delta:
 * credits.unmetered and credits.unit-costs (status usage[].creditsEach against DOCUMENTED_UNIT_COSTS) are recorded instead.
 */
export declare function runGate(options: {
  bilinc: { client: BilincClient; prefix: string };
  runId: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  waitForExpiry?: boolean;
  allowNonEmpty?: boolean;
  /** Reads status usage[] on an unmetered plan; the CLI passes a readStatusUsage() call with its key. */
  readUsage?: () => Promise<unknown>;
}): Promise<GateReport>;
