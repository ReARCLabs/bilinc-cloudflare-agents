import type { ToolUIPart } from "ai";

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
  /** Listed keys left out of the lists above because they are outside this agent's namespace. */
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

export function toolName(part: ToolUIPart): string {
  return part.type.slice("tool-".length);
}

export function isRollbackPreview(v: unknown): v is RollbackPreviewResult {
  return typeof v === "object" && v !== null && typeof (v as { previewId?: unknown }).previewId === "string";
}

function isDiff(v: unknown): v is DiffResult {
  return typeof v === "object" && v !== null && Array.isArray((v as { modified?: unknown }).modified);
}

function KeyList({ title, keys }: { title: string; keys: string[] }) {
  if (keys.length === 0) return null;
  return (
    <div className="keylist">
      <strong>{title}</strong>
      <ul>
        {keys.map((k) => (
          <li key={k}>
            <code>{k}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PreviewSummary({ preview }: { preview: RollbackPreviewResult }) {
  const { create, update, remove } = preview.counts;
  return (
    <>
      <p className="counts">
        Rollback to checkpoint <code>{preview.snapshotId}</code>: {create} to restore, {update} to change back, {remove} to remove.
      </p>
      <KeyList title="Restored" keys={preview.createKeys} />
      <KeyList title="Changed back" keys={preview.updateKeys} />
      <KeyList title="Removed" keys={preview.removeKeys} />
      {(preview.outsideNamespace ?? 0) > 0 && <p className="note">{`Keys outside this agent's namespace, not listed: ${preview.outsideNamespace}.`}</p>}
      {preview.truncated && <p className="note">The lists are cut short; the counts are complete.</p>}
      <p className="note">Rollback affects the whole Bilinc project, including other chats.</p>
    </>
  );
}

/** Result cards for the preview and diff tools; null for every other tool part. */
export function ToolCard({ part }: { part: ToolUIPart }) {
  const name = toolName(part);
  if (name !== "bilinc_rollback_preview" && name !== "bilinc_diff") return null;
  if (part.state !== "output-available") return null;
  const output: unknown = part.output;
  if (typeof output === "string") {
    return (
      <div className="card notice" data-tool={name}>
        {output}
      </div>
    );
  }
  if (name === "bilinc_rollback_preview" && isRollbackPreview(output)) {
    return (
      <div className="card" data-tool={name}>
        <PreviewSummary preview={output} />
      </div>
    );
  }
  if (name === "bilinc_diff" && isDiff(output)) {
    const { added, modified, removed } = output.counts;
    return (
      <div className="card" data-tool={name}>
        <p className="counts">
          Since checkpoint <code>{output.snapshotId}</code>: {added} added, {modified} modified, {removed} removed.
        </p>
        <KeyList title="Added" keys={output.added} />
        <KeyList title="Modified" keys={output.modified} />
        <KeyList title="Removed" keys={output.removed} />
        {(output.truncated || output.countsComplete === false) && (
          <p className="note">The lists are cut short, so the counts are too: there may be more changes.</p>
        )}
      </div>
    );
  }
  return null;
}
