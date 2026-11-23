import type { BilincHealthState } from "bilinc-cloudflare-agents";
import { useCallback, useEffect, useState } from "react";
import { fetchHealth, type GateState } from "./api";
import { Chat } from "./Chat";
import { useChatId } from "./chat-id";
import { StatusBanner } from "./StatusBanner";
import { UnlockScreen } from "./UnlockScreen";

type Health = { gate: GateState; state?: BilincHealthState };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const { chatId, startNewChat } = useChatId();

  // Called on load, after unlocking, after a failed turn and after a failed connection; never on a timer.
  // A failed check keeps the screen already shown; on first load it shows the unlock form, whose
  // unlock re-runs this check, so a visitor is never left on a chat that cannot connect.
  const refresh = useCallback(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth((prev) => prev ?? { gate: "locked" }));
  }, []);
  useEffect(refresh, [refresh]);

  if (health === null) return <p className="loading">Loading…</p>;
  if (health.gate !== "unlocked") return <UnlockScreen gate={health.gate} onUnlocked={refresh} />;
  return (
    <>
      <StatusBanner state={health.state} />
      {health.state !== "namespace_invalid" && <Chat key={chatId} chatId={chatId} onNewChat={startNewChat} onFailure={refresh} />}
    </>
  );
}
