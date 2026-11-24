import type { KeyboardEvent, Ref } from "react";
import { MEMORY_ACTIONS, type MemoryAction } from "./memory-actions";

/** The five memory actions, with 1–5 shortcuts and arrow-key movement. */
export function MemoryMenu(p: { ref?: Ref<HTMLDivElement>; selected: MemoryAction["id"] | null; onPick(action: MemoryAction): void }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const n = Number(event.key);
    if (Number.isInteger(n) && n >= 1 && n <= MEMORY_ACTIONS.length) {
      event.preventDefault();
      p.onPick(MEMORY_ACTIONS[n - 1]!);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div ref={p.ref} className="menu" role="menu" aria-label="Memory actions" onKeyDown={onKeyDown}>
      <div className="mh" aria-hidden="true">
        <span>Memory</span>
        <span>Press 1–5</span>
      </div>
      {MEMORY_ACTIONS.map((action, i) => (
        <button key={action.id} type="button" role="menuitem" className={action.id === p.selected ? "mi sel" : "mi"} onClick={() => p.onPick(action)}>
          <span className={`tone tone-${action.tone}`} aria-hidden="true" />
          <span>
            <b>{action.name}</b>
            <small>{action.note}</small>
          </span>
          <kbd aria-hidden="true">{i + 1}</kbd>
        </button>
      ))}
    </div>
  );
}
