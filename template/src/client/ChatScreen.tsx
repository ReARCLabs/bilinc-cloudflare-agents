import type { UIMessage } from "ai";
import type { BilincHealthState } from "bilinc-cloudflare-agents";
import { useCallback, useState } from "react";
import type { CheckpointsBody } from "../checkpoints";
import type { ModelChoice, ModelsConfig } from "../models";
import { ApprovalStep } from "./ApprovalStep";
import { Composer } from "./Composer";
import { Conversation } from "./Conversation";
import { EmptyState } from "./EmptyState";
import { Header } from "./Header";
import { HistoryButton } from "./History";
import { ModelSelector } from "./ModelSelector";
import { StatusBanner } from "./StatusBanner";
import { findPreview, type ApprovalTool, type Step } from "./steps";
import type { Timing } from "./timing";
import { usePhone } from "./use-phone";

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export interface ChatScreenProps {
  messages: UIMessage[];
  status: ChatStatus;
  bilincState: BilincHealthState | undefined;
  checkpoints: CheckpointsBody | null;
  models: ModelsConfig | null;
  choice: ModelChoice | null;
  timing: Timing;
  onChoice(choice: ModelChoice): void;
  onSend(text: string): void;
  onStop(): void;
  onApprove(approvalId: string): void;
  onReject(target: { toolCallId: string; tool: ApprovalTool; approvalId: string }, reason?: string): void;
  onOpenHistory(): void;
  onNewChat(): void;
}

/** The whole chat screen from plain props: no agent hook, so the fixtures and the DOM tests can drive it. */
export function ChatScreen(p: ChatScreenProps) {
  const phone = usePhone();
  const [draft, setDraft] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const busy = p.status === "submitted" || p.status === "streaming";

  // History, the suggestions and the Memory menu all fill the composer and focus it; none of them sends.
  const fill = useCallback((text: string) => {
    setDraft(text);
    setFocusTick((n) => n + 1);
  }, []);

  function renderApproval(step: Step) {
    const info = step.approval!;
    const preview = info.tool === "bilinc_rollback" ? findPreview(p.messages, info.input.previewId) : undefined;
    const checkpoint = preview ? p.checkpoints?.checkpoints.find((c) => c.id === preview.snapshotId) : undefined;
    return (
      <ApprovalStep
        info={info}
        preview={preview}
        checkpointLabel={checkpoint?.label ?? undefined}
        onApprove={() => p.onApprove(info.approvalId)}
        onReject={(reason) => p.onReject({ toolCallId: step.toolCallId, tool: info.tool, approvalId: info.approvalId }, reason)}
      />
    );
  }

  return (
    <div className={phone ? "app is-phone" : "app"}>
      <Header onNewChat={p.onNewChat} history={<HistoryButton data={p.checkpoints} onOpen={p.onOpenHistory} onPick={fill} />} />
      <StatusBanner state={p.bilincState} />
      <main className="col">
        {p.messages.length === 0 ? (
          <EmptyState onPick={fill} />
        ) : (
          <Conversation messages={p.messages} busy={busy} timing={p.timing} renderApproval={renderApproval} />
        )}
      </main>
      <div className="col composer-col">
        <Composer
          draft={draft}
          onDraft={setDraft}
          focusTick={focusTick}
          onFill={fill}
          busy={busy}
          onSend={(text) => {
            p.onSend(text);
            setDraft("");
          }}
          onStop={p.onStop}
          modelSlot={p.models && p.choice ? <ModelSelector models={p.models.models} choice={p.choice} onChange={p.onChoice} /> : undefined}
        />
      </div>
    </div>
  );
}
