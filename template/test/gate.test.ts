import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_S } from "../src/constants";
import {
  clientIp,
  handleUnlock,
  issueSessionCookie,
  isTokenLongEnough,
  limiterKey,
  passphraseMatches,
  verifySessionCookie,
} from "../src/gate";

const e = env as unknown as Env;
const PASS = "correct-horse-battery-staple"; // APP_ACCESS_TOKEN in test/wrangler.test.jsonc
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

const cookiePair = (setCookie: string) => setCookie.split(";")[0]!;

function unlock(passphrase: unknown, ip: string = crypto.randomUUID()): Promise<Response> {
  return handleUnlock(
    new Request("https://agent.test/api/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ passphrase }),
    }),
    e,
  );
}

describe("session cookie", () => {
  it("has the exact attributes and a v1.<exp>.<sig> value", async () => {
    const cookie = await issueSessionCookie(PASS, NOW);
    const exp = Math.floor(NOW / 1000) + SESSION_MAX_AGE_S;
    expect(cookie).toMatch(
      new RegExp(`^bilinc_agent_session=v1\\.${exp}\\.[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800$`),
    );
    expect(cookie).not.toContain(PASS);
  });

  it("verifies until exp and not after", async () => {
    const pair = cookiePair(await issueSessionCookie(PASS, NOW));
    expect(await verifySessionCookie(pair, PASS, NOW + 1000)).toBe(true);
    expect(await verifySessionCookie(`theme=dark; ${pair}`, PASS, NOW + 1000)).toBe(true);
    expect(await verifySessionCookie(pair, PASS, NOW + SESSION_MAX_AGE_S * 1000)).toBe(false);
  });

  it("rejects an edited exp, a missing cookie and garbage", async () => {
    const pair = cookiePair(await issueSessionCookie(PASS, NOW));
    const [, exp, sig] = pair.split("=")[1]!.split(".");
    const edited = `bilinc_agent_session=v1.${Number(exp) + 86400}.${sig}`;
    expect(await verifySessionCookie(edited, PASS, NOW)).toBe(false);
    expect(await verifySessionCookie(null, PASS, NOW)).toBe(false);
    expect(await verifySessionCookie("bilinc_agent_session=v1.abc.def", PASS, NOW)).toBe(false);
    expect(await verifySessionCookie("bilinc_agent_session=v2.99999999999.AAAA", PASS, NOW)).toBe(false);
  });

  it("is rejected after APP_ACCESS_TOKEN changes", async () => {
    const pair = cookiePair(await issueSessionCookie(PASS, NOW));
    expect(await verifySessionCookie(pair, "a-different-passphrase-1234", NOW)).toBe(false);
  });
});

describe("helpers", () => {
  it("checks the 16-character minimum", () => {
    expect(isTokenLongEnough(undefined)).toBe(false);
    expect(isTokenLongEnough("x".repeat(15))).toBe(false);
    expect(isTokenLongEnough("x".repeat(16))).toBe(true);
  });

  it("does not count whitespace at either end toward the minimum, and compares the passphrase exactly as set", async () => {
    expect(isTokenLongEnough(" ".repeat(16))).toBe(false);
    expect(isTokenLongEnough(`${"x".repeat(15)} `)).toBe(false);
    expect(isTokenLongEnough(`\n${"x".repeat(15)}\t`)).toBe(false);
    expect(isTokenLongEnough(`  ${"x".repeat(16)}  `)).toBe(true);
    const padded = `  ${"x".repeat(16)}  `;
    expect(await passphraseMatches(padded, padded)).toBe(true);
    expect(await passphraseMatches("x".repeat(16), padded)).toBe(false);
  });

  it("reads CF-Connecting-IP or falls back to unknown", () => {
    expect(clientIp(new Request("https://a.test", { headers: { "CF-Connecting-IP": "203.0.113.9" } }))).toBe("203.0.113.9");
    expect(clientIp(new Request("https://a.test"))).toBe("unknown");
  });

  it("keys the limiter on an IPv6 address's /64 and leaves IPv4 and anything else unchanged", () => {
    expect(limiterKey("203.0.113.9")).toBe("203.0.113.9");
    expect(limiterKey("unknown")).toBe("unknown");
    expect(limiterKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(limiterKey("2001:0DB8:0001:0002:ffff::1")).toBe("2001:db8:1:2::/64");
    expect(limiterKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(limiterKey("2001:db8:0:0:aaaa:bbbb:203.0.113.9")).toBe("2001:db8:0:0::/64");
    expect(limiterKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(limiterKey("::1")).toBe("0:0:0:0::/64");
    // An IPv4-mapped address is that IPv4 client, not one shared ::/64 bucket.
    expect(limiterKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(limiterKey("::ffff:cb00:7109")).toBe("203.0.113.9");
    // Not IPv6: kept as it is.
    expect(limiterKey("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(limiterKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(limiterKey("2001:db8::12345")).toBe("2001:db8::12345");
  });

  it("compares passphrases", async () => {
    expect(await passphraseMatches(PASS, PASS)).toBe(true);
    expect(await passphraseMatches(`${PASS} `, PASS)).toBe(false);
    expect(await passphraseMatches("", PASS)).toBe(false);
  });
});

describe("handleUnlock", () => {
  it("answers 200 with a cookie that verifies on the right passphrase", async () => {
    const res = await unlock(PASS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^bilinc_agent_session=v1\./);
    expect(await verifySessionCookie(cookiePair(setCookie), PASS)).toBe(true);
  });

  it("answers 401 with no cookie on a wrong passphrase or a bad body", async () => {
    const wrong = await unlock("not-the-passphrase-at-all");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_passphrase" });
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
    expect((await unlock(42)).status).toBe(401);
    const notJson = await handleUnlock(
      new Request("https://agent.test/api/unlock", { method: "POST", body: "passphrase=x" }),
      e,
    );
    expect(notJson.status).toBe(401);
  });

  it("blocks the 6th wrong attempt from one IP, even with the right passphrase, and not another IP", async () => {
    const ip = crypto.randomUUID();
    for (let i = 0; i < 5; i++) expect((await unlock("wrong-passphrase-0000", ip)).status).toBe(401);
    const blocked = await unlock("wrong-passphrase-0000", ip);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "too_many_attempts" });
    const retryAfter = Number(blocked.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(590);
    expect(retryAfter).toBeLessThanOrEqual(600);
    const blockedRight = await unlock(PASS, ip);
    expect(blockedRight.status).toBe(429);
    expect(blockedRight.headers.get("Set-Cookie")).toBeNull();
    expect((await unlock(PASS, `${ip}-other`)).status).toBe(200);
  });

  it("compares at most 5 of many parallel wrong attempts from one IP and answers 429 to the rest", async () => {
    const ip = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () => unlock("wrong-passphrase-0000", ip)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    expect((await unlock(PASS, ip)).status).toBe(429);
  });

  it("counts every IPv6 address in one /64 together, and not another /64 or an IPv4 address", async () => {
    const hex = () => Math.floor(Math.random() * 0x10000).toString(16);
    const prefix = `2001:db8:${hex()}:${hex()}`;
    for (let i = 0; i < 5; i++) expect((await unlock("wrong-passphrase-0000", `${prefix}::${i + 1}`)).status).toBe(401);
    expect((await unlock(PASS, `${prefix}:ffff:0:0:abcd`)).status).toBe(429);
    expect((await unlock(PASS, `2001:db8:${hex()}:${hex()}::1`)).status).toBe(200);
    expect((await unlock(PASS, "198.51.100.7")).status).toBe(200);
  });

  it("frees only its own slot after a successful unlock, so earlier failures from the same IP stay counted", async () => {
    const ip = crypto.randomUUID();
    for (let i = 0; i < 4; i++) expect((await unlock("wrong-passphrase-0000", ip)).status).toBe(401);
    expect((await unlock(PASS, ip)).status).toBe(200);
    expect((await unlock("wrong-passphrase-0000", ip)).status).toBe(401);
    expect((await unlock("wrong-passphrase-0000", ip)).status).toBe(429);
  });
});
