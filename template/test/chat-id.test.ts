import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_STORAGE_KEY } from "../src/constants";
import { isChatId, newChatId, readChatId, useChatId } from "../src/client/chat-id";

const A = "a1b2c3d4-2222-4333-8444-555555555555";
const B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const hashId = () => new URLSearchParams(window.location.hash.slice(1)).get("chat");

describe("chat id", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("accepts only lowercase UUIDs", () => {
    expect(isChatId(A)).toBe(true);
    expect(isChatId(A.toUpperCase())).toBe(false);
    expect(isChatId("default")).toBe(false);
    expect(isChatId(undefined)).toBe(false);
  });

  it("creates a new id on a first load and writes it to the hash and storage", () => {
    const id = readChatId();
    expect(isChatId(id)).toBe(true);
    expect(hashId()).toBe(id);
    expect(window.localStorage.getItem(CHAT_STORAGE_KEY)).toBe(id);
  });

  it("reuses the id in the hash on reload", () => {
    window.localStorage.setItem(CHAT_STORAGE_KEY, B);
    window.history.replaceState(null, "", `/#chat=${A}`);
    expect(readChatId()).toBe(A);
    expect(window.localStorage.getItem(CHAT_STORAGE_KEY)).toBe(A);
  });

  it("reuses the stored id on the bare URL", () => {
    window.localStorage.setItem(CHAT_STORAGE_KEY, B);
    expect(readChatId()).toBe(B);
    expect(hashId()).toBe(B);
  });

  it("ignores an invalid hash or stored value", () => {
    window.localStorage.setItem(CHAT_STORAGE_KEY, "not-a-uuid");
    window.history.replaceState(null, "", "/#chat=DEFAULT");
    const id = readChatId();
    expect(id).not.toBe("DEFAULT");
    expect(isChatId(id)).toBe(true);
  });

  it("works when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const id = readChatId();
    expect(isChatId(id)).toBe(true);
    expect(hashId()).toBe(id);
    expect(isChatId(newChatId())).toBe(true);
  });

  it("New chat gives a different id, and Back (hashchange) returns to the earlier chat", () => {
    window.history.replaceState(null, "", `/#chat=${A}`);
    const { result } = renderHook(() => useChatId());
    expect(result.current.chatId).toBe(A);
    act(() => result.current.startNewChat());
    const second = result.current.chatId;
    expect(second).not.toBe(A);
    expect(isChatId(second)).toBe(true);
    expect(hashId()).toBe(second);
    expect(window.localStorage.getItem(CHAT_STORAGE_KEY)).toBe(second);
    act(() => {
      window.history.replaceState(null, "", `/#chat=${A}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(result.current.chatId).toBe(A);
  });
});
