import {
  MIN_ACCESS_TOKEN_LENGTH,
  SESSION_COOKIE,
  SESSION_HKDF_INFO,
  SESSION_MAX_AGE_S,
  SESSION_VERSION,
} from "./constants";

const encoder = new TextEncoder();

export function isTokenLongEnough(token: string | undefined): boolean {
  return typeof token === "string" && token.length >= MIN_ACCESS_TOKEN_LENGTH;
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export async function deriveSessionKey(passphrase: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(SESSION_HKDF_INFO) },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function issueSessionCookie(passphrase: string, nowMs: number = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_S;
  const payload = `${SESSION_VERSION}.${exp}`;
  const key = await deriveSessionKey(passphrase);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${SESSION_COOKIE}=${payload}.${toBase64Url(sig)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}`;
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function verifySessionCookie(
  cookieHeader: string | null,
  passphrase: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const value = readCookie(cookieHeader, SESSION_COOKIE);
  if (!value) return false;
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) return false;
  const exp = Number(match[1]);
  const sig = fromBase64Url(match[2]!);
  if (!sig) return false;
  const key = await deriveSessionKey(passphrase);
  const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(`${SESSION_VERSION}.${match[1]}`));
  return valid && exp * 1000 > nowMs;
}

export async function passphraseMatches(submitted: string, configured: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(submitted)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

async function readPassphrase(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) return null;
    const passphrase = (body as { passphrase?: unknown }).passphrase;
    return typeof passphrase === "string" ? passphrase : null;
  } catch {
    return null;
  }
}

export async function handleUnlock(request: Request, env: Env): Promise<Response> {
  const limiter = env.UNLOCK_LIMITER.get(env.UNLOCK_LIMITER.idFromName(clientIp(request)));
  const gate = await limiter.attempt();
  if (gate.blocked) {
    return jsonResponse(429, { error: "too_many_attempts" }, { "Retry-After": String(gate.retryAfterSeconds) });
  }
  const submitted = await readPassphrase(request);
  if (submitted !== null && (await passphraseMatches(submitted, env.APP_ACCESS_TOKEN))) {
    await limiter.clear();
    return jsonResponse(200, { ok: true }, { "Set-Cookie": await issueSessionCookie(env.APP_ACCESS_TOKEN) });
  }
  // The failure was already counted by attempt().
  return jsonResponse(401, { error: "invalid_passphrase" });
}
