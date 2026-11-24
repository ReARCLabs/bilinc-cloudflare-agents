import type { ToolUIPart, UIMessage } from "ai";
import { REJECTED_BY_USER_PREFIX } from "../constants";
import { checkpointTitle } from "./format";
import { parseHits, type MemoryHit } from "./memory-hits";

/** Success result of bilinc_rollback_preview (tool outputs are this object or a notice string). */
export interface RollbackPreviewResult {
  previewId: string;
  snapshotId: string;
  /** Bilinc's counts for the whole project. */
  counts: { create: number; update: number; remove: number };
  /** Only this agent's entries, as keys bilinc_history and bilinc_forget accept. */
  createKeys: string[];
  updateKeys: string[];
  removeKeys: string[];
  /** Listed keys left out of the lists above: other agents' entries, and stored keys these tools cannot take. */
  outsideNamespace?: number;
  truncated: boolean;
  expiresAt: string;
}

/** Success result of bilinc_diff. */
export interface DiffResult {
  snapshotId: string;
  counts: { added: number; modified: number; removed: number };
  added: string[];
  modified: string[];
  removed: string[];
  truncated: boolean;
  /** False when the lists were cut short: the counts then only count the listed keys. */
  countsComplete?: boolean;
}

export type StepStatus = "pending" | "running" | "done" | "error" | "waiting" | "rejected";
export type ApprovalTool = "bilinc_rollback" | "bilinc_forget";

export interface ApprovalInfo {
  tool: ApprovalTool;
  approvalId: string;
  input: { key?: string; reason?: string; previewId?: string };
}

/** One row of the step list. A forget or rollback that asks the user becomes two rows: the approval and the action. */
export interface Step {
  /** The toolCallId, plus ":approval" for the approval row. */
  id: string;
  toolCallId: string;
  tool: string;
  status: StepStatus;
  label: string;
  /** One to three short mono lines under the label. */
  log: string[];
  approval?: ApprovalInfo;
}

type Part = UIMessage["parts"][number];

export function isToolPart(part: Part): part is ToolUIPart {
  return part.type.startsWith("tool-");
}

export function toolName(part: ToolUIPart): string {
  return part.type.slice("tool-".length);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const quoted = (s: string) => `"${s}"`;
const MAX_LOG_CHARS = 120;

export function isRollbackPreview(v: unknown): v is RollbackPreviewResult {
  return isObj(v) && typeof v.previewId === "string";
}

function isDiff(v: unknown): v is DiffResult {
  return isObj(v) && Array.isArray(v.modified) && isObj(v.counts);
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

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

function joinCounts(parts: [number, string][], none: string): string {
  const out = parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`);
  return out.length > 0 ? out.join(", ") : none;
}

function keyLines(groups: [string, readonly string[]][], max = 3): string[] {
  const lines: string[] = [];
  for (const [mark, keys] of groups) for (const key of keys) if (lines.length < max) lines.push(`${mark} ${key}`);
  return lines;
}

const RUNNING: Record<string, (input: Record<string, unknown>) => string> = {
  search_context: () => "Searching memory",
  set_context: () => "Saving to memory",
  bilinc_checkpoint: () => "Saving a checkpoint",
  bilinc_checkpoints: () => "Looking up checkpoints",
  bilinc_diff: () => "Comparing with the checkpoint",
  bilinc_history: (input) => `Reading the history of ${quoted(str(input.key))}`,
  bilinc_rollback_preview: () => "Previewing the rollback",
  bilinc_rollback: () => "Rolling back",
  bilinc_forget: (input) => `Forgetting ${quoted(str(input.key))}`,
};

const FAILED: Record<string, string> = {
  search_context: "Could not search memory",
  set_context: "Could not save to memory",
  bilinc_checkpoint: "Could not save a checkpoint",
  bilinc_checkpoints: "Could not list checkpoints",
  bilinc_diff: "Could not compare with the checkpoint",
  bilinc_history: "Could not read the history",
  bilinc_rollback_preview: "Could not preview the rollback",
  bilinc_rollback: "Could not roll back",
  bilinc_forget: "Could not forget",
};

const APPROVAL: Record<ApprovalTool, { action: string; waiting(i: Record<string, unknown>): string; approved(i: Record<string, unknown>): string; rejected(i: Record<string, unknown>): string }> = {
  bilinc_rollback: {
    action: "Roll back",
    waiting: () => "Waiting for you to approve the rollback",
    approved: () => "You approved the rollback",
    rejected: () => "You rejected the rollback",
  },
  bilinc_forget: {
    action: "Forget",
    waiting: (i) => `Waiting for you to approve forgetting ${quoted(str(i.key))}`,
    approved: (i) => `You approved forgetting ${quoted(str(i.key))}`,
    rejected: (i) => `You rejected forgetting ${quoted(str(i.key))}`,
  },
};

function approvalInput(input: Record<string, unknown>): ApprovalInfo["input"] {
  return {
    ...(typeof input.key === "string" ? { key: input.key } : {}),
    ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
    ...(typeof input.previewId === "string" ? { previewId: input.previewId } : {}),
  };
}

/** Label and log of a successful call; null when the output is a failure notice. */
function finished(tool: string, output: unknown): { label: string; log: string[] } | null {
  switch (tool) {
    case "search_context": {
      if (typeof output !== "string" || output.startsWith("Error:")) return null;
      const hits = parseHits(output);
      return { label: hits.length > 0 ? `Searched memory: ${hits.length} found` : "Searched memory: nothing found", log: hits.slice(0, 3).map((h) => `· ${h.key}`) };
    }
    case "set_context": {
      const m = /^Indexed "([^"]+)"/.exec(str(output));
      return m ? { label: `Saved ${quoted(m[1]!)}`, log: [] } : null;
    }
    case "bilinc_checkpoint":
      return isObj(output) && typeof output.id === "string" ? { label: `Saved the checkpoint ${quoted(str(output.label) || output.id)}`, log: [`· ${output.id}`] } : null;
    case "bilinc_checkpoints": {
      if (!isObj(output) || !Array.isArray(output.checkpoints)) return null;
      const list = output.checkpoints.filter(isObj).map((c) => ({ id: str(c.id), label: typeof c.label === "string" ? c.label : null }));
      return { label: `Listed ${plural(list.length, "checkpoint")}`, log: list.slice(0, 3).map((c) => `· ${checkpointTitle(c)}`) };
    }
    case "bilinc_diff": {
      if (!isDiff(output)) return null;
      const { added, modified, removed } = output.counts;
      return {
        label: `Compared with the checkpoint: ${joinCounts([[added, "added"], [modified, "modified"], [removed, "removed"]], "no changes")}`,
        log: keyLines([["+", output.added], ["~", output.modified], ["-", output.removed]]),
      };
    }
    case "bilinc_history":
      return isObj(output) && Array.isArray(output.entries)
        ? { label: `Read the history of ${quoted(str(output.key))}: ${plural(output.entries.length, "version")}`, log: [] }
        : null;
    case "bilinc_rollback_preview": {
      if (!isRollbackPreview(output)) return null;
      const c = output.counts;
      return {
        label: `Previewed the rollback: ${joinCounts([[c.create, "to restore"], [c.update, "to change back"], [c.remove, "to remove"]], "nothing to change")}`,
        log: keyLines([["+", output.createKeys], ["~", output.updateKeys], ["-", output.removeKeys]]),
      };
    }
    case "bilinc_rollback": {
      if (!isObj(output) || output.rolledBack !== true || !isObj(output.counts)) return null;
      const c = output.counts as { created?: number; updated?: number; deleted?: number };
      return { label: `Rolled back: ${joinCounts([[c.created ?? 0, "restored"], [c.updated ?? 0, "changed back"], [c.deleted ?? 0, "removed"]], "nothing changed")}`, log: [] };
    }
    case "bilinc_forget":
      return isObj(output) && output.forgotten === true ? { label: `Forgot ${quoted(str(output.key))}`, log: [] } : null;
    default:
      return { label: tool, log: [] };
  }
}

/** The step-list rows of one tool call, in order. */
export function partSteps(part: ToolUIPart): Step[] {
  const tool = toolName(part);
  const input: Record<string, unknown> = isObj(part.input) ? part.input : {};
  const id = part.toolCallId;
  const step = (status: StepStatus, label: string, log: string[] = []): Step => ({ id, toolCallId: id, tool, status, label, log });
  const running = RUNNING[tool]?.(input) ?? tool;
  const failed = (detail: unknown): Step => step("error", FAILED[tool] ?? `${tool} failed`, str(detail) ? [str(detail).slice(0, MAX_LOG_CHARS)] : []);
  const result = (output: unknown): Step => {
    const done = finished(tool, output);
    return done ? step("done", done.label, done.log) : failed(output);
  };

  if (tool === "bilinc_rollback" || tool === "bilinc_forget") {
    const text = APPROVAL[tool];
    const gate = (status: StepStatus, label: string, log: string[] = [], approval?: ApprovalInfo): Step => ({
      id: `${id}:approval`,
      toolCallId: id,
      tool,
      status,
      label,
      log,
      ...(approval ? { approval } : {}),
    });
    switch (part.state) {
      case "input-streaming":
        return [step("pending", text.action)];
      case "input-available":
        return [step("running", running)];
      case "approval-requested":
        return [gate("waiting", text.waiting(input), [], { tool, approvalId: part.approval.id, input: approvalInput(input) }), step("pending", text.action)];
      case "approval-responded":
        return part.approval.approved ? [gate("done", text.approved(input)), step("running", running)] : [gate("rejected", text.rejected(input))];
      case "output-denied":
        return [gate("rejected", text.rejected(input), part.approval.reason ? [quoted(part.approval.reason.slice(0, MAX_LOG_CHARS))] : [])];
      case "output-error":
        return [gate("done", text.approved(input)), failed(part.errorText)];
      case "output-available": {
        const out: unknown = part.output;
        // A Reject with a reason is recorded as an ordinary output (0.1.0 rule); show it as rejected.
        if (typeof out === "string" && out.startsWith(REJECTED_BY_USER_PREFIX)) {
          const reason = out.split("who said: ")[1];
          return [gate("rejected", text.rejected(input), reason ? [quoted(reason.slice(0, MAX_LOG_CHARS))] : [])];
        }
        return [gate("done", text.approved(input)), result(out)];
      }
    }
  }

  switch (part.state) {
    case "input-streaming":
      return [step("pending", running)];
    case "input-available":
    case "approval-requested":
    case "approval-responded":
      return [step("running", running)];
    case "output-error":
      return [failed(part.errorText)];
    case "output-denied":
      return [step("rejected", `${running}: rejected`)];
    case "output-available":
      return [result(part.output)];
  }
  return [];
}

export function buildSteps(message: UIMessage): Step[] {
  return message.parts.filter(isToolPart).flatMap(partSteps);
}

/** What the step list header says while the turn works, or null when nothing is live. */
export function activeLabel(steps: Step[]): string | null {
  if (steps.some((s) => s.status === "waiting")) return "Waiting for your approval";
  const live = steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "pending");
  return live ? live.label : null;
}

/**
 * The thinking indicator shows while a turn is busy, no step is running or waiting, and the model
 * is not streaming answer text: before the first step, and when the model resumes after a step.
 */
export function isThinking(messages: UIMessage[], busy: boolean): boolean {
  if (!busy) return false;
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return true;
  if (buildSteps(last).some((s) => s.status === "running" || s.status === "waiting")) return false;
  const lastPart = [...last.parts].reverse().find((p) => p.type === "text" || isToolPart(p));
  return !(lastPart?.type === "text" && lastPart.text.trim().length > 0);
}

/** The search_context hits of one assistant message: the memory chips may cite only these. */
export function hitsOf(message: UIMessage): MemoryHit[] {
  return message.parts
    .filter(isToolPart)
    .filter((part) => toolName(part) === "search_context" && part.state === "output-available")
    .flatMap((part) => parseHits(part.output));
}

/** Whether an assistant message called a bilinc_* tool (History then refreshes). */
export function ranBilincTool(message: UIMessage | undefined): boolean {
  return message?.role === "assistant" && message.parts.some((part) => isToolPart(part) && toolName(part).startsWith("bilinc_"));
}
