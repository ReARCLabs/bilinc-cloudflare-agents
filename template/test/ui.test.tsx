import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ToolUIPart, UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BANNER_TEXT, TOKEN_TOO_SHORT_TEXT } from "../src/constants";
import { App } from "../src/client/App";
import { ApprovalCard, NO_PREVIEW_TEXT } from "../src/client/ApprovalCard";
import { Chat } from "../src/client/Chat";
import { StatusBanner } from "../src/client/StatusBanner";
import { ToolCard, type RollbackPreviewResult } from "../src/client/ToolCards";
import { NETWORK_ERROR_TEXT, SERVER_ERROR_TEXT, tooManyAttemptsText, UnlockScreen, WRONG_PASSPHRASE_TEXT } from "../src/client/UnlockScreen";

const hooks = vi.hoisted(() => ({
  useAgent: vi.fn((options: unknown) => ({ options })),
  chat: {
    messages: [] as UIMessage[],
    sendMessage: vi.fn(),
    status: "ready" as string,
    connectionError: null as Error | null,
    addToolApprovalResponse: vi.fn(),
    addToolOutput: vi.fn(),
  },
}));
vi.mock("agents/react", () => ({ useAgent: hooks.useAgent }));
vi.mock("@cloudflare/think/react", () => ({ useAgentChat: () => hooks.chat }));

const CHAT = "11111111-2222-4333-8444-555555555555";

const preview: RollbackPreviewResult = {
  previewId: "p-1",
  snapshotId: "snap_1",
  counts: { create: 0, update: 1, remove: 2 },
  createKeys: [],
  updateKeys: ["cf.default.favourite-colour"],
  removeKeys: ["cf.default.a", "cf.default.b"],
  truncated: true,
  expiresAt: "2026-11-23T12:05:00.000Z",
};
const previewPart = { type: "tool-bilinc_rollback_preview", toolCallId: "c1", state: "output-available", input: {}, output: preview } as unknown as ToolUIPart;
const rollbackPart = (previewId: string) =>
  ({ type: "tool-bilinc_rollback", toolCallId: "c2", state: "approval-requested", input: { previewId }, approval: { id: "appr-2" } }) as unknown as ToolUIPart;
const forgetPart = { type: "tool-bilinc_forget", toolCallId: "c3", state: "approval-requested", input: { key: "old-fact", reason: "wrong" }, approval: { id: "appr-3" } } as unknown as ToolUIPart;
const assistant = (...parts: unknown[]): UIMessage => ({ id: crypto.randomUUID(), role: "assistant", parts: parts as UIMessage["parts"] });

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

beforeEach(() => {
  hooks.chat.messages = [];
  hooks.chat.status = "ready";
  hooks.chat.connectionError = null;
  window.history.replaceState(null, "", `/#chat=${CHAT}`);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("StatusBanner", () => {
  it("shows the exact text for each failing state and nothing for ok", () => {
    for (const state of ["key_missing", "key_invalid", "namespace_invalid", "unreachable"] as const) {
      const { unmount } = render(<StatusBanner state={state} />);
      expect(screen.getByText(BANNER_TEXT[state])).toBeTruthy();
      unmount();
    }
    expect(render(<StatusBanner state="ok" />).container.textContent).toBe("");
  });

  it("links to the signup page for key problems only", () => {
    render(<StatusBanner state="key_missing" />);
    expect(screen.getByRole("link").getAttribute("href")).toContain("utm_campaign=bilinc-cloudflare-agents");
    cleanup();
    render(<StatusBanner state="unreachable" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("UnlockScreen", () => {
  it("shows the too-short message without a form", () => {
    render(<UnlockScreen gate="token_too_short" onUnlocked={() => {}} />);
    expect(screen.getByText(TOKEN_TOO_SHORT_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  async function submit(passphrase: string) {
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: passphrase } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  }

  it("calls onUnlocked after a 200", async () => {
    mockFetch(() => new Response('{"ok":true}', { status: 200 }));
    const onUnlocked = vi.fn();
    render(<UnlockScreen gate="locked" onUnlocked={onUnlocked} />);
    await submit("correct-horse-battery-staple");
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/unlock");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ passphrase: "correct-horse-battery-staple" });
  });

  it("says the passphrase is wrong after a 401", async () => {
    mockFetch(() => new Response('{"error":"invalid_passphrase"}', { status: 401 }));
    render(<UnlockScreen gate="locked" onUnlocked={() => {}} />);
    await submit("wrong-passphrase-0000");
    expect(await screen.findByText(WRONG_PASSPHRASE_TEXT)).toBeTruthy();
  });

  it("says the agent could not be reached when the request fails, and clears that on the next answer", async () => {
    mockFetch(() => new Response('{"error":"invalid_passphrase"}', { status: 401 }));
    render(<UnlockScreen gate="locked" onUnlocked={() => {}} />);
    await submit("wrong-passphrase-0000");
    expect(await screen.findByText(WRONG_PASSPHRASE_TEXT)).toBeTruthy();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await submit("correct-horse-battery-staple");
    expect(await screen.findByText(NETWORK_ERROR_TEXT)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Unlock" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(WRONG_PASSPHRASE_TEXT)).toBeNull();
    mockFetch(() => new Response('{"error":"invalid_passphrase"}', { status: 401 }));
    await submit("wrong-passphrase-0000");
    expect(await screen.findByText(WRONG_PASSPHRASE_TEXT)).toBeTruthy();
    expect(screen.queryByText(NETWORK_ERROR_TEXT)).toBeNull();
  });

  it("says the agent answered with an error, not that the passphrase is wrong, after a 500, 400 or 405", async () => {
    for (const status of [500, 400, 405]) {
      mockFetch(() => new Response('{"error":"internal"}', { status }));
      render(<UnlockScreen gate="locked" onUnlocked={() => {}} />);
      await submit("correct-horse-battery-staple");
      expect(await screen.findByText(SERVER_ERROR_TEXT)).toBeTruthy();
      expect(screen.queryByText(WRONG_PASSPHRASE_TEXT)).toBeNull();
      expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("correct-horse-battery-staple");
      mockFetch(() => new Response('{"error":"invalid_passphrase"}', { status: 401 }));
      await submit("wrong-passphrase-0000");
      expect(await screen.findByText(WRONG_PASSPHRASE_TEXT)).toBeTruthy();
      expect(screen.queryByText(SERVER_ERROR_TEXT)).toBeNull();
      cleanup();
    }
  });

  it("keeps the form and shows the server-error text after a 503 without the too-short body", async () => {
    mockFetch(() => new Response("<html>Service Unavailable</html>", { status: 503 }));
    render(<UnlockScreen gate="locked" onUnlocked={() => {}} />);
    await submit("correct-horse-battery-staple");
    expect(await screen.findByText(SERVER_ERROR_TEXT)).toBeTruthy();
    expect(screen.queryByText(TOKEN_TOO_SHORT_TEXT)).toBeNull();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
  });

  it("shows the wait after a 429 and the too-short text after a 503", async () => {
    mockFetch(() => new Response('{"error":"too_many_attempts"}', { status: 429, headers: { "Retry-After": "42" } }));
    render(<UnlockScreen gate="locked" onUnlocked={() => {}} />);
    await submit("wrong-passphrase-0000");
    expect(await screen.findByText(tooManyAttemptsText(42))).toBeTruthy();
    cleanup();
    mockFetch(() => new Response('{"error":"access_token_too_short"}', { status: 503 }));
    render(<UnlockScreen gate="locked" onUnlocked={() => {}} />);
    await submit("anything-at-all-123");
    expect(await screen.findByText(TOKEN_TOO_SHORT_TEXT)).toBeTruthy();
  });
});

describe("App", () => {
  it("shows the unlock screen when /api/health answers 401", async () => {
    mockFetch(() => new Response('{"error":"unauthorized"}', { status: 401 }));
    render(<App />);
    expect(await screen.findByLabelText("Passphrase")).toBeTruthy();
    expect(hooks.useAgent).not.toHaveBeenCalled();
  });

  it("shows the too-short message when /api/health answers 503", async () => {
    mockFetch(() => new Response('{"error":"access_token_too_short"}', { status: 503 }));
    render(<App />);
    expect(await screen.findByText(TOKEN_TOO_SHORT_TEXT)).toBeTruthy();
  });

  it("treats a 503 from /api/health without the too-short body like any other failed answer", async () => {
    for (const body of ["<html>Service Unavailable</html>", '{"error":"overloaded"}', ""]) {
      mockFetch(() => new Response(body, { status: 503 }));
      render(<App />);
      await waitFor(() => expect(hooks.useAgent).toHaveBeenCalled());
      expect(screen.queryByText(TOKEN_TOO_SHORT_TEXT)).toBeNull();
      cleanup();
      vi.clearAllMocks();
    }
  });

  it("shows the banner and connects to the chat named in the hash", async () => {
    mockFetch(() => new Response('{"state":"key_invalid"}', { status: 200 }));
    render(<App />);
    expect(await screen.findByText(BANNER_TEXT.key_invalid)).toBeTruthy();
    expect(hooks.useAgent).toHaveBeenCalledWith({ agent: "BilincAgent", name: CHAT });
  });

  it("does not open the chat while the namespace is invalid", async () => {
    mockFetch(() => new Response('{"state":"namespace_invalid"}', { status: 200 }));
    render(<App />);
    expect(await screen.findByText(BANNER_TEXT.namespace_invalid)).toBeTruthy();
    expect(hooks.useAgent).not.toHaveBeenCalled();
  });

  it("re-checks health after a failed connection", async () => {
    mockFetch(() => new Response('{"state":"ok"}', { status: 200 }));
    hooks.chat.connectionError = Object.assign(new Error("closed"), { code: 1006, reason: "", wasClean: false });
    render(<App />);
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe("ToolCard", () => {
  it("renders the preview counts, key lists and truncated note", () => {
    render(<ToolCard part={previewPart} />);
    expect(screen.getByText(/1 to change back, 2 to remove/)).toBeTruthy();
    expect(screen.getByText("cf.default.favourite-colour")).toBeTruthy();
    expect(screen.getByText(/cut short/)).toBeTruthy();
  });

  it("renders the diff counts and keys", () => {
    const diffPart = {
      type: "tool-bilinc_diff",
      toolCallId: "d1",
      state: "output-available",
      input: { snapshotId: "snap_1" },
      output: { snapshotId: "snap_1", counts: { added: 0, modified: 1, removed: 0 }, added: [], modified: ["favourite-colour"], removed: [], truncated: false },
    } as unknown as ToolUIPart;
    render(<ToolCard part={diffPart} />);
    expect(screen.getByText(/0 added, 1 modified, 0 removed/)).toBeTruthy();
    expect(screen.getByText("favourite-colour")).toBeTruthy();
  });

  it("says the diff counts are partial when the lists were cut short", () => {
    const diffPart = {
      type: "tool-bilinc_diff",
      toolCallId: "d2",
      state: "output-available",
      input: { snapshotId: "snap_1" },
      output: { snapshotId: "snap_1", counts: { added: 1, modified: 0, removed: 0 }, added: ["a"], modified: [], removed: [], truncated: true, countsComplete: false },
    } as unknown as ToolUIPart;
    const { container } = render(<ToolCard part={diffPart} />);
    expect(container.textContent).not.toMatch(/counts are complete/);
    expect(screen.getByText(/cut short, so the counts are too/)).toBeTruthy();
  });

  it("shows a notice string as text and ignores other tools", () => {
    const notice = { ...(previewPart as object), output: "checkpoint not found; call bilinc_checkpoints to list the ids that exist" } as unknown as ToolUIPart;
    render(<ToolCard part={notice} />);
    expect(screen.getByText(/checkpoint not found/)).toBeTruthy();
    cleanup();
    const other = { type: "tool-search_context", toolCallId: "s", state: "output-available", input: {}, output: "x" } as unknown as ToolUIPart;
    expect(render(<ToolCard part={other} />).container.textContent).toBe("");
  });
});

describe("ApprovalCard", () => {
  it("offers Approve and Reject for forget", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ApprovalCard part={forgetPart} onApprove={onApprove} onReject={onReject} />);
    expect(screen.getByText("old-fact")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledWith(undefined);
  });

  it("shows the preview for a rollback and passes a typed reason on Reject", () => {
    const onReject = vi.fn();
    render(<ApprovalCard part={rollbackPart("p-1")} preview={preview} onApprove={() => {}} onReject={onReject} />);
    expect(screen.getByText(/0 to restore, 1 to change back, 2 to remove/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason for rejecting (optional)"), { target: { value: "keep red" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith("keep red");
  });

  it("offers only Reject for a rollback without a matching preview", () => {
    render(<ApprovalCard part={rollbackPart("unknown")} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByText(NO_PREVIEW_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("Chat", () => {
  it("connects with the chat id and wires approvals to the hooks", () => {
    hooks.chat.messages = [assistant(previewPart, rollbackPart("p-1"))];
    render(<Chat chatId={CHAT} onNewChat={() => {}} onFailure={() => {}} />);
    expect(hooks.useAgent).toHaveBeenCalledWith({ agent: "BilincAgent", name: CHAT });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(hooks.chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: "appr-2", approved: true });
  });

  it("sends a plain Reject as a denial and a Reject with a reason as a tool error", () => {
    hooks.chat.messages = [assistant(previewPart, rollbackPart("p-1"))];
    render(<Chat chatId={CHAT} onNewChat={() => {}} onFailure={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(hooks.chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: "appr-2", approved: false });
    fireEvent.change(screen.getByLabelText("Reason for rejecting (optional)"), { target: { value: "keep red" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(hooks.chat.addToolOutput).toHaveBeenCalledWith({
      toolCallId: "c2",
      toolName: "bilinc_rollback",
      state: "output-error",
      errorText: "keep red",
    });
  });

  it("finds no preview when the ids differ, so Approve is not offered", () => {
    hooks.chat.messages = [assistant(previewPart, rollbackPart("p-other"))];
    render(<Chat chatId={CHAT} onNewChat={() => {}} onFailure={() => {}} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("calls onNewChat and reports a failed turn", () => {
    const onNewChat = vi.fn();
    const onFailure = vi.fn();
    hooks.chat.status = "error";
    render(<Chat chatId={CHAT} onNewChat={onNewChat} onFailure={onFailure} />);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
