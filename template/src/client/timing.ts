import { useRef } from "react";
import type { UIMessage } from "ai";
import { isToolPart } from "./steps";

/** Client-observed timing of one tool call; unknown for calls that were already finished when this page first saw them. */
export interface ToolTime {
  start: number;
  end?: number;
  /** True while the call waits for the user's approval; that wait is left out of the duration. */
  waiting?: boolean;
}

export type Timing = Map<string, ToolTime>;

const FINAL = new Set(["output-available", "output-error", "output-denied"]);

export function updateTiming(timing: Timing, messages: UIMessage[], now: number): void {
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part)) continue;
      const t = timing.get(part.toolCallId);
      if (!t) {
        // First seen finished or waiting (a reload, or history loading): the duration is unknown.
        if (FINAL.has(part.state) || part.state === "approval-requested") continue;
        timing.set(part.toolCallId, { start: now });
        continue;
      }
      if (t.end !== undefined) continue;
      if (part.state === "approval-requested") {
        t.waiting = true;
        continue;
      }
      if (t.waiting) {
        t.waiting = false;
        t.start = now;
      }
      if (FINAL.has(part.state)) t.end = now;
    }
  }
}

export function stepDuration(timing: Timing, toolCallId: string): number | undefined {
  const t = timing.get(toolCallId);
  return t?.end === undefined ? undefined : t.end - t.start;
}

/** The sum of the step durations, or undefined when any is unknown. */
export function workedFor(toolCallIds: string[], timing: Timing): number | undefined {
  let total = 0;
  for (const id of toolCallIds) {
    const d = stepDuration(timing, id);
    if (d === undefined) return undefined;
    total += d;
  }
  return total;
}

export function turnStart(toolCallIds: string[], timing: Timing): number | undefined {
  const starts = toolCallIds.map((id) => timing.get(id)?.start).filter((s): s is number => s !== undefined);
  return starts.length > 0 ? Math.min(...starts) : undefined;
}

/** One timing map per chat view, updated on every render from the messages it shows. */
export function useToolTiming(messages: UIMessage[]): Timing {
  const ref = useRef<Timing>(new Map());
  updateTiming(ref.current, messages, performance.now());
  return ref.current;
}
