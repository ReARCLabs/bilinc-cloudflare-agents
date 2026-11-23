import { useEffect, useState, type FormEvent } from "react";
import { MIN_ACCESS_TOKEN_LENGTH, TOKEN_TOO_SHORT_TEXT } from "../constants";
import { unlock, type GateState, type HealthCheck } from "./api";

export const WRONG_PASSPHRASE_TEXT = "That passphrase is not right.";
export const NETWORK_ERROR_TEXT = "Could not reach the agent. Check your connection and try again.";
export const SERVER_ERROR_TEXT = "The agent answered with an error. Try again in a moment.";
export const tooManyAttemptsText = (seconds?: number) =>
  `Too many wrong attempts from this network. Try again in ${seconds ?? 600} seconds.`;
export const UNLOCKED_NO_SESSION_TEXT =
  "The passphrase is right, but this browser did not keep the session cookie. Allow cookies for this site and try again.";
export const UNLOCKED_CHECK_FAILED_TEXT =
  "The passphrase is right, but the agent did not answer the check that follows. Try again in a moment.";

type AfterUnlock = "no_session" | "check_failed" | null;

/** `onUnlocked` re-runs the health check after a 200 and resolves to what it found. */
export function UnlockScreen(p: { gate: GateState; retryAfterSeconds?: number; onUnlocked(): Promise<HealthCheck> }) {
  const [gate, setGate] = useState<GateState>(p.gate);
  const [retryAfter, setRetryAfter] = useState(p.retryAfterSeconds);
  const [wrong, setWrong] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [serverError, setServerError] = useState(false);
  const [afterUnlock, setAfterUnlock] = useState<AfterUnlock>(null);
  const [busy, setBusy] = useState(false);

  // The parent's gate can change while this screen stays mounted (a later health check); follow it.
  useEffect(() => setGate(p.gate), [p.gate]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("passphrase") as HTMLInputElement;
    setBusy(true);
    setNetworkError(false);
    setServerError(false);
    setAfterUnlock(null);
    try {
      const result = await unlock(input.value);
      if (result.ok) {
        setWrong(false);
        const check = await p.onUnlocked().catch((): HealthCheck => "failed");
        // "unlocked" replaces this screen with the chat. Otherwise the passphrase stays for the retry.
        if (check === "locked") setAfterUnlock("no_session");
        else if (check === "failed") setAfterUnlock("check_failed");
        else if (check !== "unlocked") setGate(check);
        return;
      }
      setGate(result.gate);
      setRetryAfter(result.retryAfterSeconds);
      setServerError(result.serverError === true);
      setWrong(result.gate === "locked" && result.serverError !== true);
      // After a server error the passphrase may well be right, so it stays for the retry.
      if (result.serverError !== true) input.value = "";
    } catch {
      setNetworkError(true);
    } finally {
      setBusy(false);
    }
  }

  if (gate === "token_too_short") {
    return (
      <main className="unlock">
        <h1>Bilinc agent</h1>
        <p className="error">{TOKEN_TOO_SHORT_TEXT}</p>
      </main>
    );
  }

  return (
    <main className="unlock">
      <h1>Bilinc agent</h1>
      <p>Enter the access passphrase chosen when this agent was deployed.</p>
      <form onSubmit={submit}>
        <label htmlFor="passphrase">Passphrase</label>
        <input id="passphrase" name="passphrase" type="password" autoComplete="current-password" minLength={MIN_ACCESS_TOKEN_LENGTH} required />
        <button type="submit" disabled={busy}>
          Unlock
        </button>
      </form>
      {afterUnlock === "no_session" && <p className="error">{UNLOCKED_NO_SESSION_TEXT}</p>}
      {afterUnlock === "check_failed" && <p className="error">{UNLOCKED_CHECK_FAILED_TEXT}</p>}
      {networkError && <p className="error">{NETWORK_ERROR_TEXT}</p>}
      {!networkError && serverError && <p className="error">{SERVER_ERROR_TEXT}</p>}
      {!networkError && gate === "too_many_attempts" && <p className="error">{tooManyAttemptsText(retryAfter)}</p>}
      {!networkError && gate !== "too_many_attempts" && wrong && <p className="error">{WRONG_PASSPHRASE_TEXT}</p>}
    </main>
  );
}
