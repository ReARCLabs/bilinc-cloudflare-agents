import { useCallback, useEffect, useState } from "react";
import { CHAT_HASH_PARAM, CHAT_ID_RE, CHAT_STORAGE_KEY } from "../constants";

export { CHAT_ID_RE };

export function isChatId(v: unknown): v is string {
  return typeof v === "string" && CHAT_ID_RE.test(v);
}

function idFromHash(): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get(CHAT_HASH_PARAM);
  return isChatId(value) ? value : null;
}

function idFromStorage(): string | null {
  try {
    const value = window.localStorage.getItem(CHAT_STORAGE_KEY);
    return isChatId(value) ? value : null;
  } catch {
    return null;
  }
}

function store(id: string): void {
  try {
    window.localStorage.setItem(CHAT_STORAGE_KEY, id);
  } catch {
    // Storage is blocked: the hash still carries the chat id.
  }
}

function writeHash(id: string, mode: "replace" | "push"): void {
  const url = new URL(window.location.href);
  url.hash = `${CHAT_HASH_PARAM}=${id}`;
  if (mode === "push") window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

/** Hash first, then localStorage, then a new id; the chosen id is written to both. */
export function readChatId(): string {
  const id = idFromHash() ?? idFromStorage() ?? crypto.randomUUID();
  writeHash(id, "replace");
  store(id);
  return id;
}

/** A fresh chat id, pushed as a new history entry so Back returns to the previous chat. */
export function newChatId(): string {
  const id = crypto.randomUUID();
  writeHash(id, "push");
  store(id);
  return id;
}

export function useChatId(): { chatId: string; startNewChat(): void } {
  const [chatId, setChatId] = useState(readChatId);

  useEffect(() => {
    const onHashChange = () => {
      const id = idFromHash();
      if (id) {
        store(id);
        setChatId(id);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const startNewChat = useCallback(() => setChatId(newChatId()), []);
  return { chatId, startNewChat };
}
