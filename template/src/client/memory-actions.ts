export interface MemoryAction {
  id: "remember" | "recall" | "checkpoint" | "compare" | "rollback";
  name: string;
  /** The menu's second line. */
  note: string;
  /** The band above the box while the action is selected. */
  hint: string;
  tone: "added" | "recall" | "glass" | "changed" | "removed";
  /** Intent text: a prefix the user completes, or a whole message. */
  text: string;
  mode: "prefix" | "replace";
}

export const MEMORY_ACTIONS: readonly MemoryAction[] = [
  { id: "remember", name: "Remember", note: "Save a fact to long-term memory", hint: "Remember: the agent saves what you say", tone: "added", text: "Remember that ", mode: "prefix" },
  { id: "recall", name: "Recall", note: "Search what the agent remembers", hint: "Recall: the agent searches its memory first", tone: "recall", text: "What do you remember about ", mode: "prefix" },
  { id: "checkpoint", name: "Checkpoint", note: "Save a point you can return to · 2 credits", hint: "Checkpoint: a point you can return to · 2 credits", tone: "glass", text: "Checkpoint now.", mode: "replace" },
  { id: "compare", name: "Compare", note: "What changed since a checkpoint", hint: "Compare: what changed since a checkpoint", tone: "changed", text: "Diff against the last checkpoint.", mode: "replace" },
  { id: "rollback", name: "Roll back", note: "Return to a checkpoint · asks you first", hint: "Roll back: returns to a checkpoint and asks you first", tone: "removed", text: "Roll back to the last checkpoint.", mode: "replace" },
];

/** The composer text after picking an action. It only sets intent text: it never calls a tool and never sends. */
export function applyAction(draft: string, action: MemoryAction): string {
  if (action.mode === "replace") return action.text;
  const rest = draft.replace(/^\//, "").trimStart();
  return rest.startsWith(action.text) ? rest : action.text + rest;
}
