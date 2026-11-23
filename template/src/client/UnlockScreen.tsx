import { useState, type FormEvent } from "react";
import { MIN_ACCESS_TOKEN_LENGTH, TOKEN_TOO_SHORT_TEXT } from "../constants";
import { unlock, type GateState } from "./api";

export const WRONG_PASSPHRASE_TEXT = "That passphrase is not right.";
export const tooManyAttemptsText = (seconds?: number) =>
  `Too many wrong attempts from this network. Try again in ${seconds ?? 600} seconds.`;

export function UnlockScreen(p: { gate: GateState; retryAfterSeconds?: number; onUnlocked(): void }) {
  const [gate, setGate] = useState<GateState>(p.gate);
  const [retryAfter, setRetryAfter] = useState(p.retryAfterSeconds);
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("passphrase") as HTMLInputElement;
    setBusy(true);
    try {
      const result = await unlock(input.value);
      if (result.ok) return p.onUnlocked();
      setGate(result.gate);
      setRetryAfter(result.retryAfterSeconds);
      setWrong(result.gate === "locked");
      input.value = "";
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
      {gate === "too_many_attempts" && <p className="error">{tooManyAttemptsText(retryAfter)}</p>}
      {gate !== "too_many_attempts" && wrong && <p className="error">{WRONG_PASSPHRASE_TEXT}</p>}
    </main>
  );
}
