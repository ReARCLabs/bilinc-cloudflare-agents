import type { BilincClient } from '../src/index';

export declare const GATE_NAMESPACE: 'gate';
export declare const TOKEN_TTL_MS: number;
export declare const EXPIRY_WAIT_MS: number;
export declare const CREDIT_SETTLE_ATTEMPTS: number;
export declare const CREDIT_SETTLE_DELAY_MS: number;

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
/** Writes the report as JSON, readable by its owner only, also when a file is already at that path. */
export declare function writeReport(reportPath: string, body: unknown): void;
export declare function runGate(options: {
  bilinc: { client: BilincClient; prefix: string };
  runId: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  waitForExpiry?: boolean;
  allowNonEmpty?: boolean;
}): Promise<GateReport>;
