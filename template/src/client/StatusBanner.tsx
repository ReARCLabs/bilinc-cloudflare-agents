import type { BilincHealthState } from "bilinc-cloudflare-agents";
import { BANNER_TEXT, SIGNUP_URL } from "../constants";

export function StatusBanner({ state }: { state: BilincHealthState | undefined }) {
  if (state === undefined || state === "ok") return null;
  const needsKey = state === "key_missing" || state === "key_invalid";
  return (
    <div className={`banner banner-${state}`} role="status">
      <span>{BANNER_TEXT[state]}</span>
      {needsKey && (
        <a href={SIGNUP_URL} target="_blank" rel="noreferrer">
          Get a free Bilinc key
        </a>
      )}
    </div>
  );
}
