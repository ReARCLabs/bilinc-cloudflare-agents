import { useState } from "react";
import type { ApprovalInfo, RollbackPreviewResult } from "./steps";

export const NO_PREVIEW_TEXT = "No preview with this id was found in the chat, so this rollback can only be rejected.";

/**
 * The amber approval inside a waiting step: one sentence, a button named for the action, an inline
 * reason and Reject. Roll back is offered only with the matching preview (0.1.0 rule).
 */
export function ApprovalStep(p: {
  info: ApprovalInfo;
  preview?: RollbackPreviewResult;
  checkpointLabel?: string;
  onApprove(): void;
  onReject(reason?: string): void;
}) {
  const [reason, setReason] = useState("");
  const { tool, input } = p.info;
  const canApprove = tool === "bilinc_forget" || p.preview !== undefined;
  const reject = () => p.onReject(reason.trim() || undefined);

  return (
    <div className="appr" data-tool={tool}>
      {tool === "bilinc_forget" && (
        <p className="appr-text">
          Forget <code>{input.key}</code> from long-term memory?{input.reason ? ` The agent says: ${input.reason}` : ""}
        </p>
      )}
      {tool === "bilinc_rollback" &&
        (p.preview ? (
          <>
            <p className="appr-text">
              Roll back the whole Bilinc project to <b>{p.checkpointLabel ?? p.preview.snapshotId}</b>? Other chats are included.
            </p>
            {(p.preview.outsideNamespace ?? 0) > 0 && (
              <p className="appr-note">{`Keys not listed (other agents' entries, or keys these tools cannot take): ${p.preview.outsideNamespace}.`}</p>
            )}
            {p.preview.truncated && <p className="appr-note">The lists are cut short; the counts are complete.</p>}
          </>
        ) : (
          <p className="appr-text">{NO_PREVIEW_TEXT}</p>
        ))}
      <div className="row">
        {canApprove && (
          <button type="button" className="btn-warn" onClick={() => p.onApprove()}>
            {tool === "bilinc_rollback" ? "Roll back" : "Forget"}
          </button>
        )}
        <input
          aria-label="Reason for rejecting (optional)"
          placeholder="Or say why not…"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && reason.trim()) {
              event.preventDefault();
              reject();
            }
          }}
        />
        <button type="button" className="btn-plain" onClick={reject}>
          Reject
        </button>
      </div>
    </div>
  );
}
