import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import type { ToolUIPart, UIMessage } from "ai";
import { useEffect, type FormEvent } from "react";
import { AGENT_BINDING, rejectedByUserOutput } from "../constants";
import { ApprovalCard } from "./ApprovalCard";
import { isRollbackPreview, ToolCard, toolName, type RollbackPreviewResult } from "./ToolCards";

const APPROVAL_TOOLS = new Set(["bilinc_forget", "bilinc_rollback"]);

function isToolPart(part: UIMessage["parts"][number]): part is ToolUIPart {
  return part.type.startsWith("tool-");
}

/** The bilinc_rollback_preview result in this chat whose previewId matches, if any. */
export function findPreview(messages: UIMessage[], previewId: unknown): RollbackPreviewResult | undefined {
  if (typeof previewId !== "string") return undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part) || toolName(part) !== "bilinc_rollback_preview" || part.state !== "output-available") continue;
      if (isRollbackPreview(part.output) && part.output.previewId === previewId) return part.output;
    }
  }
  return undefined;
}

export function Chat(p: { chatId: string; onNewChat(): void; onFailure(): void }) {
  const agent = useAgent({ agent: AGENT_BINDING, name: p.chatId });
  const { messages, sendMessage, status, addToolApprovalResponse, addToolOutput, connectionError } = useAgentChat({ agent });

  const failed = status === "error" || connectionError !== null;
  useEffect(() => {
    if (failed) p.onFailure();
    // Only the transition into failure matters; onFailure re-checks /api/health.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("message") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    void sendMessage({ text });
    input.value = "";
  }

  function renderTool(part: ToolUIPart) {
    const name = toolName(part);
    if (part.state === "approval-requested" && APPROVAL_TOOLS.has(name)) {
      const approvalId = part.approval.id;
      const input = (part.input ?? {}) as { previewId?: unknown };
      return (
        <ApprovalCard
          key={part.toolCallId}
          part={part}
          preview={name === "bilinc_rollback" ? findPreview(messages, input.previewId) : undefined}
          onApprove={() => void addToolApprovalResponse({ id: approvalId, approved: true })}
          onReject={(reason) =>
            reason
              ? addToolOutput({ toolCallId: part.toolCallId, toolName: name, output: rejectedByUserOutput(reason) })
              : void addToolApprovalResponse({ id: approvalId, approved: false })
          }
        />
      );
    }
    return <ToolCard part={part} />;
  }

  return (
    <section className="chat">
      <header>
        <h1>Bilinc agent</h1>
        <button type="button" onClick={p.onNewChat}>
          New chat
        </button>
      </header>
      <ol className="messages">
        {messages.map((message) => (
          <li key={message.id} className={`message ${message.role}`}>
            {message.parts.map((part, i) => {
              if (part.type === "text") return <p key={i}>{part.text}</p>;
              if (isToolPart(part)) {
                return (
                  <div key={part.toolCallId} className="tool">
                    <span className="tool-name">
                      {toolName(part)} · {part.state}
                    </span>
                    {renderTool(part)}
                  </div>
                );
              }
              return null;
            })}
          </li>
        ))}
      </ol>
      <form onSubmit={submit}>
        <input name="message" placeholder="Message" autoComplete="off" />
        <button type="submit" disabled={status === "submitted" || status === "streaming"}>
          Send
        </button>
      </form>
    </section>
  );
}
