import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CheckpointsBody } from "../checkpoints";
import { checkpointTime, checkpointTitle, diffAgainstText } from "./format";
import { Icon } from "./icons";
import { useDismiss } from "./use-dismiss";

export const HISTORY_EMPTY_TEXT = "No checkpoints yet. The agent makes one when a chat starts.";
export const HISTORY_UNAVAILABLE_TEXT = "Checkpoints cannot be read right now.";

/** The History glass button and its popover. Choosing a checkpoint only fills the composer; it never sends. */
export function HistoryButton(p: { data: CheckpointsBody | null; onOpen(): void; onPick(text: string): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, [wrap], close, button);

  // Focus the newest checkpoint on open, and again once a refresh started by opening arrives.
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>("button.hist-row")?.focus();
  }, [open, p.data]);

  const data = p.data;
  const rows = data?.checkpoints ?? [];
  return (
    <div className="history" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="glass-btn"
        aria-label="History"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          if (!open) p.onOpen();
          setOpen(!open);
        }}
      >
        <Icon name="history" />
        <span className="btn-text">History</span>
      </button>
      {open && (
        <div ref={panel} id={panelId} className="popover history-panel" role="dialog" aria-label="Checkpoints">
          {data === null ? (
            <p className="popover-note">Loading checkpoints…</p>
          ) : data.state !== "ok" ? (
            <p className="popover-note">{HISTORY_UNAVAILABLE_TEXT}</p>
          ) : (
            <>
              {data.now && (
                <div className="hist-row now">
                  <span>Now</span>{" "}
                  <span className="mono hist-count">{data.now.total === 1 ? "1 entry" : `${data.now.total} entries`}</span>
                </div>
              )}
              {rows.length === 0 ? (
                <p className="popover-note">{HISTORY_EMPTY_TEXT}</p>
              ) : (
                rows.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="hist-row"
                    onClick={() => {
                      p.onPick(diffAgainstText(c));
                      setOpen(false);
                    }}
                  >
                    <span>{checkpointTitle(c)}</span> <span className="mono hist-time">{checkpointTime(c.createdAt)}</span>
                  </button>
                ))
              )}
              {rows.length > 0 && <p className="popover-foot">Pick one to diff against it</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
