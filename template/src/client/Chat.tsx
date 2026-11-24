import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import type { BilincHealthState } from "bilinc-cloudflare-agents";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckpointsBody } from "../checkpoints";
import { AGENT_BINDING, rejectedByUserOutput } from "../constants";
import type { AgentUiState, ModelsConfig } from "../models";
import { fetchCheckpoints } from "./api";
import { ChatScreen, type ChatStatus } from "./ChatScreen";
import { ranBilincTool } from "./steps";
import { useToolTiming } from "./timing";
import { useModelChoice } from "./use-model-choice";

/** Every hook of the chat: the agent socket, the model choice, the checkpoints. ChatScreen draws it. */
export function Chat(p: {
  chatId: string;
  models: ModelsConfig | null;
  bilincState: BilincHealthState | undefined;
  onBilincState(state: BilincHealthState): void;
  onNewChat(): void;
  onFailure(): void;
}) {
  const agent = useAgent<AgentUiState>({ agent: AGENT_BINDING, name: p.chatId });
  const [choice, setChoice, sendable] = useModelChoice(p.models, agent.state);
  const choiceRef = useRef(choice);
  choiceRef.current = sendable ? choice : null;
  // The body is read on every send, so the request always carries the current choice. The Worker
  // checks it against MODELS; anything else runs MODEL. Before the agent state arrives (and the
  // user has not picked) it sends {}, so the Worker keeps the chat's stored choice.
  const { messages, sendMessage, status, stop, addToolApprovalResponse, addToolOutput, connectionError } = useAgentChat({
    agent,
    body: () => (choiceRef.current ? { model: choiceRef.current.model, effort: choiceRef.current.effort } : {}),
  });
  const timing = useToolTiming(messages);
  const [checkpoints, setCheckpoints] = useState<CheckpointsBody | null>(null);

  const callbacks = useRef(p);
  callbacks.current = p;
  const refreshCheckpoints = useCallback(async () => {
    try {
      const result = await fetchCheckpoints();
      if (result === "locked") {
        callbacks.current.onFailure();
        return;
      }
      if (result.state === "ok") {
        setCheckpoints(result);
      } else if (result.state === "key_missing" || result.state === "key_invalid") {
        setCheckpoints(result);
        callbacks.current.onBilincState(result.state);
      } else {
        // One failed read says little about Bilinc: keep a list already shown and let /api/health decide the banner.
        setCheckpoints((shown) => (shown?.state === "ok" ? shown : result));
        callbacks.current.onFailure();
      }
    } catch {
      // Keep the list already shown; /api/health decides about the banner.
    }
  }, []);

  // Once when the chat opens (so the approval step can name the checkpoint), when History opens,
  // and after each turn that ran a bilinc_* tool. All free reads.
  useEffect(() => void refreshCheckpoints(), [refreshCheckpoints]);
  const busy = status === "submitted" || status === "streaming";
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && ranBilincTool(messages.at(-1))) void refreshCheckpoints();
    wasBusy.current = busy;
  }, [busy, messages, refreshCheckpoints]);

  const failed = status === "error" || connectionError !== null;
  useEffect(() => {
    if (failed) p.onFailure();
    // Only the transition into failure matters; onFailure re-checks /api/health.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);

  return (
    <ChatScreen
      messages={messages}
      status={status as ChatStatus}
      bilincState={p.bilincState}
      checkpoints={checkpoints}
      models={p.models}
      choice={choice}
      timing={timing}
      onChoice={setChoice}
      onSend={(text) => void sendMessage({ text })}
      onStop={() => void stop()}
      onApprove={(id) => void addToolApprovalResponse({ id, approved: true })}
      onReject={(target, reason) =>
        reason
          ? addToolOutput({ toolCallId: target.toolCallId, toolName: target.tool, output: rejectedByUserOutput(reason) })
          : void addToolApprovalResponse({ id: target.approvalId, approved: false })
      }
      onOpenHistory={() => void refreshCheckpoints()}
      onNewChat={p.onNewChat}
    />
  );
}
