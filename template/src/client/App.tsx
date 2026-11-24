import type { BilincHealthState } from "bilinc-cloudflare-agents";
import { useCallback, useEffect, useState } from "react";
import type { ModelsConfig } from "../models";
import { fetchHealth, fetchModels, type GateState, type HealthCheck } from "./api";
import { Chat } from "./Chat";
import { useChatId } from "./chat-id";
import { Header } from "./Header";
import { StatusBanner } from "./StatusBanner";
import { UnlockScreen } from "./UnlockScreen";

type Health = { gate: GateState; state?: BilincHealthState };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [models, setModels] = useState<ModelsConfig | null>(null);
  const { chatId, startNewChat } = useChatId();

  // Called on load, after unlocking, after a failed turn and after a failed connection; never on a timer.
  // A failed check keeps the screen already shown; on first load it shows the unlock form, whose
  // unlock re-runs this check, so a visitor is never left on a chat that cannot connect.
  // It resolves to what this check found, so the unlock form can say why it is still shown.
  const refresh = useCallback(async (): Promise<HealthCheck> => {
    try {
      const next = await fetchHealth();
      setHealth(next);
      if (next.gate === "unlocked") {
        void fetchModels().then((config) => {
          if (config) setModels(config);
        });
      }
      return next.gate;
    } catch {
      setHealth((prev) => prev ?? { gate: "locked" });
      return "failed";
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  // An ok answer or a key problem from /api/checkpoints moves the banner; its other failures re-run /api/health (onFailure).
  const onBilincState = useCallback(
    (state: BilincHealthState) => setHealth((prev) => (prev && prev.state !== state ? { ...prev, state } : prev)),
    [],
  );
  const onFailure = useCallback(() => void refresh(), [refresh]);

  if (health === null) {
    return (
      <p className="loading" role="status">
        Loading…
      </p>
    );
  }
  if (health.gate !== "unlocked") return <UnlockScreen gate={health.gate} onUnlocked={refresh} />;
  if (health.state === "namespace_invalid") {
    return (
      <div className="app">
        <Header onNewChat={startNewChat} />
        <StatusBanner state={health.state} />
      </div>
    );
  }
  return (
    <Chat key={chatId} chatId={chatId} models={models} bilincState={health.state} onBilincState={onBilincState} onNewChat={startNewChat} onFailure={onFailure} />
  );
}
