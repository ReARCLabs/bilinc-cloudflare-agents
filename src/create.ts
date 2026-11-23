import type { ContextConfig } from "agents/context";
import { createClient } from "./client";
import type { BilincClient, BilincProfile } from "./client";
import {
  DEFAULT_BASE_URL,
  DEFAULT_LIMIT,
  DEFAULT_MAX_CHARS,
  DEFAULT_NAMESPACE,
  DEFAULT_PROFILE,
  KEY_PREFIX,
  MAX_LIMIT,
  NAMESPACE_RE,
} from "./constants";
import { defaultOnError } from "./errors";
import type { BilincError } from "./errors";
import { Guard } from "./guard";
import { httpsBaseUrl } from "./health";
import { createMemoryBlock } from "./provider";
import type { MemoryBlockContext } from "./provider";

export interface BilincOptions {
  apiKey: string;
  /** Default "default" when undefined; must match /^[A-Za-z0-9_-]{1,64}$/, else createBilinc() throws. */
  namespace?: string;
  agentId?: string;
  sessionId?: string;
  /** https only; default "https://bilinc.space". */
  baseUrl?: string;
  profile?: BilincProfile;
  /** Hits returned by search(); default 5, clamped to 1..25. */
  limit?: number;
  /** Cap on search() output; default 6000. */
  maxChars?: number;
  onError?: (error: BilincError, op: string) => void;
}

export interface Bilinc {
  client: BilincClient;
  memoryBlock(overrides?: { label?: string; description?: string; maxTokens?: number }): ContextConfig;
  /** "cf.<namespace>.": every stored key starts with it. */
  readonly prefix: string;
}

export const NAMESPACE_ERROR = "Bilinc namespace is invalid: use 1–64 letters, digits, `_` or `-`";
export const BASE_URL_ERROR = "Bilinc baseUrl must be an https URL";

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * One instance per Durable Object: it owns the circuit breaker and the rate cap, shared by
 * `client`, `memoryBlock()` and the tools built from it. Throws only for an invalid namespace
 * or a non-https baseUrl. An empty apiKey does not throw: the server answers `missing_api_key`,
 * which opens the breaker at once.
 */
export function createBilinc(options: BilincOptions): Bilinc {
  const namespace = options.namespace === undefined ? DEFAULT_NAMESPACE : options.namespace;
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) throw new Error(NAMESPACE_ERROR);

  const baseUrl = httpsBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  if (!baseUrl) throw new Error(BASE_URL_ERROR);

  const client = createClient({
    apiKey: typeof options.apiKey === "string" ? options.apiKey.trim() : "",
    baseUrl,
    guard: new Guard(),
    onError: options.onError ?? defaultOnError,
  });
  const prefix = KEY_PREFIX(namespace);
  const context: MemoryBlockContext = {
    client,
    prefix,
    namespace,
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    profile: options.profile ?? DEFAULT_PROFILE,
    limit: clampLimit(options.limit),
    maxChars: positiveInteger(options.maxChars, DEFAULT_MAX_CHARS),
  };

  return {
    client,
    prefix,
    memoryBlock: (overrides) => createMemoryBlock(context, overrides),
  };
}
