import { AUTO_CHECKPOINT_LABEL_PREFIX } from "../constants";

/** "0.0s" to "59.9s", then "1m 2.3s" (the mockup's timer format). */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

/** A History row title: "auto · chat start" for the automatic checkpoints, else the label, else the id. */
export function checkpointTitle(c: { id: string; label: string | null }): string {
  if (c.label?.startsWith(AUTO_CHECKPOINT_LABEL_PREFIX)) return "auto · chat start";
  return c.label?.trim() || c.id;
}

/** "07:32" for today, "Nov 23" for an earlier day (local time); "" for an invalid date. */
export function checkpointTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The composer text a History pick fills in (spec). */
export function diffAgainstText(c: { id: string; label: string | null }): string {
  return `Diff against the checkpoint "${c.label?.trim() || c.id}".`;
}
