import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./icons";
import { applyAction, type MemoryAction } from "./memory-actions";
import { MemoryMenu } from "./MemoryMenu";
import { useDismiss } from "./use-dismiss";

export const COMPOSER_PLACEHOLDER = "Ask anything, or type / for memory actions";
const MIN_HEIGHT = 56;
const MAX_HEIGHT = 200;

/**
 * The glass composer (Kokonut AI Input Search pattern, rebuilt). Enter sends, Shift+Enter is a new
 * line, Escape stops a running turn, "/" in an empty box opens the Memory menu. Picking an action
 * only fills the box.
 */
export function Composer(p: {
  draft: string;
  onDraft(text: string): void;
  focusTick: number;
  onFill(text: string): void;
  busy: boolean;
  onSend(text: string): void;
  onStop(): void;
  modelSlot?: ReactNode;
}) {
  const [action, setAction] = useState<MemoryAction | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const bandKey = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuOpen, [menu, pill, bandKey], closeMenu, textarea);

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight))}px`;
  }, [p.draft]);

  useEffect(() => {
    if (p.focusTick === 0) return;
    const el = textarea.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [p.focusTick]);

  useEffect(() => {
    if (menuOpen) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [menuOpen]);

  const empty = p.draft.trim() === "";

  function pick(next: MemoryAction) {
    setAction(next);
    setMenuOpen(false);
    p.onFill(applyAction(p.draft, next));
  }

  function send() {
    if (empty || p.busy) return;
    p.onSend(p.draft.trim());
    setAction(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === "Escape" && p.busy) {
      event.preventDefault();
      p.onStop();
      return;
    }
    if (event.key === "/" && p.draft === "") {
      event.preventDefault();
      setMenuOpen(true);
    }
  }

  return (
    <div className="box">
      {menuOpen && <MemoryMenu ref={menu} selected={action?.id ?? null} onPick={pick} />}
      {action && (
        <div className="band">
          <span className={`tone tone-${action.tone}`} aria-hidden="true" />
          <span>{action.hint}</span>
          <button ref={bandKey} type="button" className="key" onClick={() => setMenuOpen(true)}>
            Change /
          </button>
        </div>
      )}
      <textarea
        ref={textarea}
        className="ta"
        aria-label="Message"
        placeholder={COMPOSER_PLACEHOLDER}
        rows={1}
        value={p.draft}
        onChange={(event) => p.onDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="foot">
        <button ref={pill} type="button" className="pill" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <span className={`tone tone-${action?.tone ?? "added"}`} aria-hidden="true" />
          Memory
          <Icon name="caretDown" size={12} />
        </button>
        {p.modelSlot ?? <span className="msel" />}
        {p.busy ? (
          <button type="button" className="ask stop" onClick={p.onStop}>
            <Icon name="stop" size={12} />
            Stop
          </button>
        ) : (
          <button type="button" className="ask" aria-disabled={empty} onClick={send}>
            Ask
            <Icon name="enter" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
