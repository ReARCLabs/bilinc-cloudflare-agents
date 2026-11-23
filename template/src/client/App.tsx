import type { BilincHealthState } from "bilinc-cloudflare-agents";
import { useCallback, useEffect, useState } from "react";
import { fetchHealth, type GateState, type HealthCheck } from "./api";
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
  // It resolves to what this check found, so the unlock form can say why it is still shown.
  const refresh = useCallback(async (): Promise<HealthCheck> => {
    try {
      const next = await fetchHealth();
      setHealth(next);
      return next.gate;
    } catch {
      setHealth((prev) => prev ?? { gate: "locked" });
      return "failed";
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  if (health === null) return <p className="loading">Loading…</p>;
  if (health.gate !== "unlocked") return <UnlockScreen gate={health.gate} onUnlocked={refresh} />;
  return (
    <>
      <StatusBanner state={health.state} />
      {health.state !== "namespace_invalid" && <Chat key={chatId} chatId={chatId} onNewChat={startNewChat} onFailure={() => void refresh()} />}
    </>
  );
}
