import { issueSessionCookie } from "../../src/gate";

/** The Cookie header value a browser sends after unlocking with `passphrase`. */
export async function sessionCookie(passphrase = "correct-horse-battery-staple"): Promise<string> {
  return (await issueSessionCookie(passphrase)).split(";")[0]!;
}
