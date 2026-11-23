import type { ToolUIPart } from "ai";
import { useState } from "react";
import { PreviewSummary, toolName, type RollbackPreviewResult } from "./ToolCards";

export const NO_PREVIEW_TEXT = "No preview with this id was found in the chat, so this rollback can only be rejected.";

export function ApprovalCard(p: {
  part: ToolUIPart;
  preview?: RollbackPreviewResult;
  onApprove(): void;
  onReject(reason?: string): void;
}) {
  const [reason, setReason] = useState("");
  const name = toolName(p.part);
  const input = (p.part.input ?? {}) as { key?: string; reason?: string };
  const canApprove = name === "bilinc_forget" || (name === "bilinc_rollback" && p.preview !== undefined);

  return (
    <div className="card approval" data-tool={name}>
      {name === "bilinc_forget" && (
        <p>
          The agent wants to forget <code>{input.key}</code>
          {input.reason ? ` because: ${input.reason}` : "."}
        </p>
      )}
      {name === "bilinc_rollback" && (p.preview ? <PreviewSummary preview={p.preview} /> : <p className="note">{NO_PREVIEW_TEXT}</p>)}
      <div className="actions">
        {canApprove && (
          <button type="button" onClick={() => p.onApprove()}>
            Approve
          </button>
        )}
        <input
          aria-label="Reason for rejecting (optional)"
          placeholder="Reason for rejecting (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <button type="button" onClick={() => p.onReject(reason.trim() || undefined)}>
          Reject
        </button>
      </div>
    </div>
  );
}
