import { useCallback, useEffect, useRef, useState } from "react";
import { resolveChoice, type AgentUiState, type ModelChoice, type ModelsConfig } from "../models";

/**
 * The selector's value: the chat's stored choice (agent state from the Durable Object) until the
 * user picks one, checked against MODELS either way. Null until the allowlist has loaded.
 * The third value says whether the choice may be sent: only once the agent state has arrived or
 * the user has picked, so an early send cannot reset the chat's stored model to the default.
 */
export function useModelChoice(
  config: ModelsConfig | null,
  server: AgentUiState | undefined,
): [ModelChoice | null, (choice: ModelChoice) => void, boolean] {
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const touched = useRef(false);
  const [picked, setPicked] = useState(false);
  const serverModel = server?.model ?? null;
  const serverEffort = server?.effort ?? null;

  useEffect(() => {
    if (!config || touched.current) return;
    setChoice(resolveChoice(undefined, config, { model: serverModel, effort: serverEffort }));
  }, [config, serverModel, serverEffort]);

  const change = useCallback((next: ModelChoice) => {
    touched.current = true;
    setPicked(true);
    setChoice(next);
  }, []);

  return [choice, change, picked || server !== undefined];
}
