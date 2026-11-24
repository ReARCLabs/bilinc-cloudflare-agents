import type { UIMessage } from "ai";
import type { ReactNode } from "react";
import { Answer } from "./Answer";
import { StepList } from "./StepList";
import { buildSteps, hitsOf, isThinking, type Step } from "./steps";
import { Thinking } from "./Thinking";
import type { Timing } from "./timing";

type Part = UIMessage["parts"][number];
type TextPart = Extract<Part, { type: "text" }>;

function textOf(message: UIMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function AssistantTurn(p: { message: UIMessage; active: boolean; timing: Timing; renderApproval(step: Step): ReactNode }) {
  const steps = buildSteps(p.message);
  const hits = hitsOf(p.message);
  const texts = p.message.parts.filter((part): part is TextPart => part.type === "text" && part.text.trim() !== "");
  return (
    <>
      {steps.length > 0 && <StepList steps={steps} timing={p.timing} active={p.active} renderApproval={p.renderApproval} />}
      {texts.map((part, i) => (
        <Answer key={i} text={part.text} hits={hits} />
      ))}
    </>
  );
}

/** User bubbles, one step list per assistant turn that calls tools, answers with memory chips, and the thinking indicator. */
export function Conversation(p: { messages: UIMessage[]; busy: boolean; timing: Timing; renderApproval(step: Step): ReactNode }) {
  const lastId = p.messages.at(-1)?.id;
  return (
    <ol className="conv" aria-label="Conversation">
      {p.messages.map((message) => {
        if (message.role === "user") {
          return (
            <li key={message.id} className="you">
              {textOf(message)}
            </li>
          );
        }
        if (message.role !== "assistant") return null;
        return (
          <li key={message.id} className="turn">
            <AssistantTurn message={message} active={p.busy && message.id === lastId} timing={p.timing} renderApproval={p.renderApproval} />
          </li>
        );
      })}
      {isThinking(p.messages, p.busy) && (
        <li className="turn">
          <Thinking />
        </li>
      )}
    </ol>
  );
}
