import { useState, type ReactNode } from "react";
import { formatElapsed } from "./format";
import { Icon, Spinner } from "./icons";
import { activeLabel, type Step, type StepStatus } from "./steps";
import { stepDuration, turnStart, workedFor, type Timing } from "./timing";
import { useNow } from "./use-now";

const STATUS_TEXT: Record<StepStatus, string> = {
  pending: "Next",
  running: "Running",
  done: "Done",
  error: "Failed",
  waiting: "Waiting for you",
  rejected: "Rejected",
};

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "pending":
      return <span className="dot" />;
    case "running":
      return <Spinner />;
    case "waiting":
      return <Spinner tone="wait" />;
    case "done":
      return <Icon name="check" size={14} />;
    case "error":
    case "rejected":
      return <Icon name="x" size={14} />;
  }
}

/** The per-letter wave (Kokonut AI Loading pattern, rebuilt). Screen readers get the plain text. */
function Wave({ text }: { text: string }) {
  return (
    <>
      <span className="wave" aria-hidden="true">
        {[...text].map((ch, i) => (
          <span key={i} style={{ animationDelay: `${(i * 0.05).toFixed(2)}s` }}>
            {ch === " " ? " " : ch}
          </span>
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}

/** One assistant turn's tool calls as a step list; collapses to "Worked for X.Xs · N steps" when done. */
export function StepList(p: { steps: Step[]; timing: Timing; active: boolean; renderApproval(step: Step): ReactNode }) {
  const ids = [...new Set(p.steps.map((s) => s.toolCallId))];
  const live = activeLabel(p.steps);
  const working = p.active || live !== null;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? working;
  const now = useNow(working);
  const start = turnStart(ids, p.timing);
  const worked = workedFor(ids, p.timing);
  const count = `${ids.length} ${ids.length === 1 ? "step" : "steps"}`;

  return (
    <section className="steps corner" aria-label="Agent steps">
      <button type="button" className="sh" aria-expanded={open} onClick={() => setUserOpen(!open)}>
        {working ? (
          <>
            <Wave text={live ?? "Working"} />
            {start !== undefined && <span className="el">{formatElapsed(now - start)}</span>}
          </>
        ) : (
          <>
            <b>{worked !== undefined ? `Worked for ${formatElapsed(worked)}` : "Done"}</b>
            <span>{` · ${count}`}</span>
          </>
        )}
        <Icon name="caretDown" size={14} className="chev" />
      </button>
      {open && (
        <ol className="steps-list">
          {p.steps.map((s) => {
            const timed = !s.id.endsWith(":approval") && (s.status === "done" || s.status === "error");
            const duration = timed ? stepDuration(p.timing, s.toolCallId) : undefined;
            return (
              <li key={s.id} className={`st ${s.status}`}>
                <span className="ic" aria-hidden="true">
                  <StepIcon status={s.status} />
                </span>
                <div className="lab">
                  <span className="sr-only">{`${STATUS_TEXT[s.status]}: `}</span>
                  <span className="lab-text">{s.label}</span>
                  {s.log.length > 0 && (
                    <div className="log">
                      {s.log.map((line, i) => (
                        <div key={i}>
                          <span aria-hidden="true">{i + 1}</span>
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                  {s.approval && s.status === "waiting" && p.renderApproval(s)}
                </div>
                {duration !== undefined && <span className="dur">{formatElapsed(duration)}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
