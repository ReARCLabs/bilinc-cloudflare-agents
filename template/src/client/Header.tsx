import type { ReactNode } from "react";
import { Lockup } from "./brand";
import { Icon } from "./icons";

/** Lockup on the left; History (slot) and New chat glass buttons on the right. */
export function Header(p: { onNewChat(): void; history?: ReactNode }) {
  return (
    <header className="top">
      <Lockup as="h1" />
      <nav className="top-actions" aria-label="Chat actions">
        {p.history}
        <button type="button" className="glass-btn" aria-label="New chat" onClick={p.onNewChat}>
          <Icon name="plus" />
          <span className="btn-text">New chat</span>
        </button>
      </nav>
    </header>
  );
}
