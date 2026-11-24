import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ToolUIPart, UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BANNER_TEXT, rejectedByUserOutput, TOKEN_TOO_SHORT_TEXT } from "../src/constants";
import { parseModels } from "../src/models";
import { App } from "../src/client/App";
import { Chat } from "../src/client/Chat";
import { StatusBanner } from "../src/client/StatusBanner";
import type { RollbackPreviewResult } from "../src/client/steps";
import {
  NETWORK_ERROR_TEXT,
  SERVER_ERROR_TEXT,
  tooManyAttemptsText,
  UNLOCKED_CHECK_FAILED_TEXT,
  UNLOCKED_NO_SESSION_TEXT,
  UnlockScreen,
  WRONG_PASSPHRASE_TEXT,
} from "../src/client/UnlockScreen";

const hooks = vi.hoisted(() => ({
  agentState: undefined as unknown,
  useAgent: vi.fn(),
  chatOptions: null as null | { body?: () => Record<string, unknown> },
  chat: {
    messages: [] as UIMessage[],
    sendMessage: vi.fn(),
    status: "ready" as string,
    connectionError: null as Error | null,
    addToolApprovalResponse: vi.fn(),
    addToolOutput: vi.fn(),
    stop: vi.fn(),
  },
}));
vi.mock("agents/react", () => ({ useAgent: hooks.useAgent }));
vi.mock("@cloudflare/think/react", () => ({
  useAgentChat: (options: { body?: () => Record<string, unknown> }) => {
    hooks.chatOptions = options;
    return hooks.chat;
  },
}));

const CHAT = "11111111-2222-4333-8444-555555555555";

const preview: RollbackPreviewResult = {
  previewId: "p-1",
  snapshotId: "snap_1",
  counts: { create: 0, update: 1, remove: 2 },
  createKeys: [],
  updateKeys: ["favourite-colour"],
  removeKeys: ["a"],
  outsideNamespace: 1,
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
  hooks.chatOptions = null;
  hooks.agentState = undefined;
  hooks.useAgent.mockImplementation((options: unknown) => ({ options, state: hooks.agentState }));
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
  const stillLocked = async () => "locked" as const;
  it("shows the too-short message without a form", () => {
    render(<UnlockScreen gate="token_too_short" onUnlocked={stillLocked} />);
    expect(screen.getByText(TOKEN_TOO_SHORT_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("follows a gate the parent changes while the screen stays mounted", () => {
    const { rerender } = render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
    expect(screen.getByLabelText("Passphrase")).toBeTruthy();
    rerender(<UnlockScreen gate="token_too_short" onUnlocked={stillLocked} />);
    expect(screen.getByText(TOKEN_TOO_SHORT_TEXT)).toBeTruthy();
  });

  async function submit(passphrase: string) {
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: passphrase } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  }

  it("calls onUnlocked after a 200", async () => {
    mockFetch(() => new Response('{"ok":true}', { status: 200 }));
    const onUnlocked = vi.fn(async () => "unlocked" as const);
    render(<UnlockScreen gate="locked" onUnlocked={onUnlocked} />);
    await submit("correct-horse-battery-staple");
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/unlock");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ passphrase: "correct-horse-battery-staple" });
  });
  it("shows the lockup and shakes the card once after a wrong passphrase", async () => {
    mockFetch(() => new Response('{"error":"invalid_passphrase"}', { status: 401 }));
    const { container } = render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
    expect(screen.getByRole("heading", { level: 1, name: "Bilinc Memory" })).toBeTruthy();
    await submit("wrong-passphrase-0000");
    await screen.findByText(WRONG_PASSPHRASE_TEXT);
    const card = container.querySelector(".unlock-card")!;
    expect(card.classList.contains("shake")).toBe(true);
    // jsdom has no AnimationEvent, so React listens for the prefixed name there; browsers get "animationend".
    fireEvent(card, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(card.classList.contains("shake")).toBe(false);
  });


  it("says the passphrase is wrong after a 401", async () => {
    mockFetch(() => new Response('{"error":"invalid_passphrase"}', { status: 401 }));
    render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
    await submit("wrong-passphrase-0000");
    expect(await screen.findByText(WRONG_PASSPHRASE_TEXT)).toBeTruthy();
  });

  it("says the agent could not be reached when the request fails, and clears that on the next answer", async () => {
    mockFetch(() => new Response('{"error":"invalid_passphrase"}', { status: 401 }));
    render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
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
      render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
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
    render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
    await submit("correct-horse-battery-staple");
    expect(await screen.findByText(SERVER_ERROR_TEXT)).toBeTruthy();
    expect(screen.queryByText(TOKEN_TOO_SHORT_TEXT)).toBeNull();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
  });

  it("shows the wait after a 429 and the too-short text after a 503", async () => {
    mockFetch(() => new Response('{"error":"too_many_attempts"}', { status: 429, headers: { "Retry-After": "42" } }));
    render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
    await submit("wrong-passphrase-0000");
    expect(await screen.findByText(tooManyAttemptsText(42))).toBeTruthy();
    cleanup();
    mockFetch(() => new Response('{"error":"access_token_too_short"}', { status: 503 }));
    render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
    await submit("anything-at-all-123");
    expect(await screen.findByText(TOKEN_TOO_SHORT_TEXT)).toBeTruthy();
  });

  it("drops the wait text after a later 200 whose follow-up check does not unlock", async () => {
    for (const check of ["locked", "failed"] as const) {
      mockFetch(() => new Response('{"error":"too_many_attempts"}', { status: 429, headers: { "Retry-After": "42" } }));
      render(<UnlockScreen gate="locked" onUnlocked={async () => check} />);
      await submit("wrong-passphrase-0000");
      expect(await screen.findByText(tooManyAttemptsText(42))).toBeTruthy();
      mockFetch(() => new Response('{"ok":true}', { status: 200 }));
      await submit("correct-horse-battery-staple");
      expect(await screen.findByText(check === "locked" ? UNLOCKED_NO_SESSION_TEXT : UNLOCKED_CHECK_FAILED_TEXT)).toBeTruthy();
      expect(screen.queryByText(tooManyAttemptsText(42))).toBeNull();
      cleanup();
    }
  });

  it("falls back to the 600-second wait after a 429 with no, an empty, a zero or a malformed Retry-After", async () => {
    for (const headers of [{}, { "Retry-After": "" }, { "Retry-After": "0" }, { "Retry-After": "0.5" }, { "Retry-After": "-5" }, { "Retry-After": "0x10" }] as Record<string, string>[]) {
      mockFetch(() => new Response('{"error":"too_many_attempts"}', { status: 429, headers }));
      render(<UnlockScreen gate="locked" onUnlocked={stillLocked} />);
      await submit("wrong-passphrase-0000");
      expect(await screen.findByText(tooManyAttemptsText(600))).toBeTruthy();
      expect(screen.queryByText(tooManyAttemptsText(0))).toBeNull();
      cleanup();
    }
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

  it("shows the unlock form, not the chat, when the first /api/health fails with a 500, another 503 or no answer", async () => {
    const failures: (() => Response)[] = [
      () => new Response("<html>Service Unavailable</html>", { status: 503 }),
      () => new Response('{"error":"overloaded"}', { status: 503 }),
      () => new Response("", { status: 503 }),
      () => new Response("Internal Server Error", { status: 500 }),
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const failure of failures) {
      mockFetch(failure);
      render(<App />);
      expect(await screen.findByLabelText("Passphrase")).toBeTruthy();
      expect(screen.queryByText(TOKEN_TOO_SHORT_TEXT)).toBeNull();
      expect(hooks.useAgent).not.toHaveBeenCalled();
      cleanup();
      vi.clearAllMocks();
    }
  });

  it("keeps the chat open when the health re-check after a failed connection answers 500", async () => {
    let healthCalls = 0;
    mockFetch((url) => {
      if (url !== "/api/health") return new Response('{"state":"ok"}', { status: 200 });
      return ++healthCalls === 1 ? new Response('{"state":"ok"}', { status: 200 }) : new Response("oops", { status: 500 });
    });
    const { rerender } = render(<App />);
    await waitFor(() => expect(hooks.useAgent).toHaveBeenCalled());
    hooks.chat.connectionError = Object.assign(new Error("closed"), { code: 1006, reason: "", wasClean: false });
    rerender(<App />);
    await waitFor(() => expect(healthCalls).toBe(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
  });

  it("loads the model allowlist once unlocked and shows the selector", async () => {
    const models = {
      default: "@cf/openai/gpt-oss-120b",
      models: [{ id: "@cf/openai/gpt-oss-120b", label: "gpt-oss-120b", note: "", tag: "tested", effort: ["low", "medium", "high"] }],
    };
    mockFetch((url) => (url === "/api/models" ? new Response(JSON.stringify(models), { status: 200 }) : new Response('{"state":"ok"}', { status: 200 })));
    render(<App />);
    expect(await screen.findByRole("button", { name: "Model: gpt-oss-120b, Medium reasoning. Change" })).toBeTruthy();
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

  describe("after a successful unlock, when the health check that follows does not say unlocked", () => {
    /** /api/health answers `first` on load and `after` once /api/unlock has answered 200. */
    function serve(first: () => Response, after: () => Response) {
      let unlocked = false;
      mockFetch((url) => {
        if (url === "/api/unlock") {
          unlocked = true;
          return new Response('{"ok":true}', { status: 200 });
        }
        return unlocked ? after() : first();
      });
    }
    async function unlockInApp() {
      render(<App />);
      fireEvent.change(await screen.findByLabelText("Passphrase"), { target: { value: "correct-horse-battery-staple" } });
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    }
    const locked = () => new Response('{"error":"unauthorized"}', { status: 401 });

    it("says the agent did not accept the new session when /api/health still answers 401, and keeps the passphrase", async () => {
      serve(locked, locked);
      await unlockInApp();
      expect(await screen.findByText(UNLOCKED_NO_SESSION_TEXT)).toBeTruthy();
      expect(UNLOCKED_NO_SESSION_TEXT).toBe(
        "The passphrase is right, but the agent did not accept the new session. Allow cookies for this site and try again; if it keeps happening, the access token may have just changed.",
      );
      expect(screen.queryByText(WRONG_PASSPHRASE_TEXT)).toBeNull();
      expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("correct-horse-battery-staple");
      expect(hooks.useAgent).not.toHaveBeenCalled();
    });

    it("says the check failed when /api/health answers 500, another 503 or nothing", async () => {
      const failures: (() => Response)[] = [
        () => new Response("Internal Server Error", { status: 500 }),
        () => new Response("<html>Service Unavailable</html>", { status: 503 }),
        () => {
          throw new TypeError("Failed to fetch");
        },
      ];
      for (const failure of failures) {
        serve(locked, failure);
        await unlockInApp();
        expect(await screen.findByText(UNLOCKED_CHECK_FAILED_TEXT)).toBeTruthy();
        expect(screen.queryByText(NETWORK_ERROR_TEXT)).toBeNull();
        expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("correct-horse-battery-staple");
        expect(hooks.useAgent).not.toHaveBeenCalled();
        cleanup();
        vi.clearAllMocks();
      }
    });

    it("shows the too-short message when /api/health then answers the too-short 503", async () => {
      serve(locked, () => new Response('{"error":"access_token_too_short"}', { status: 503 }));
      await unlockInApp();
      expect(await screen.findByText(TOKEN_TOO_SHORT_TEXT)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Unlock" })).toBeNull();
    });

    it("clears the message and opens the chat once a later unlock is followed by a 200", async () => {
      let healthAfter: () => Response = locked;
      serve(locked, () => healthAfter());
      await unlockInApp();
      expect(await screen.findByText(UNLOCKED_NO_SESSION_TEXT)).toBeTruthy();
      healthAfter = () => new Response('{"state":"ok"}', { status: 200 });
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
      await waitFor(() => expect(hooks.useAgent).toHaveBeenCalled());
      expect(screen.queryByText(UNLOCKED_NO_SESSION_TEXT)).toBeNull();
    });
  });

  it("re-checks health after a failed connection", async () => {
    let healthCalls = 0;
    mockFetch((url) => {
      if (url === "/api/health") healthCalls++;
      return new Response('{"state":"ok"}', { status: 200 });
    });
    hooks.chat.connectionError = Object.assign(new Error("closed"), { code: 1006, reason: "", wasClean: false });
    render(<App />);
    await waitFor(() => expect(healthCalls).toBeGreaterThanOrEqual(2));
  });

});

const MODELS = parseModels(
  [
    { id: "@cf/openai/gpt-oss-120b", label: "gpt-oss-120b", note: "", tag: "tested", effort: ["low", "medium", "high"] },
    { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "llama-4-scout", note: "", tag: "tested", effort: null },
  ],
  "@cf/openai/gpt-oss-120b",
);
const CHECKPOINTS = {
  state: "ok",
  now: { total: 1 },
  checkpoints: [{ id: "snap_1", label: "Before tea change", createdAt: new Date().toISOString(), totalEntries: 1 }],
};

function serveCheckpoints(body: unknown = CHECKPOINTS) {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderChat() {
  const props = {
    chatId: CHAT,
    models: MODELS,
    bilincState: "ok" as const,
    onBilincState: vi.fn(),
    onNewChat: vi.fn(),
    onFailure: vi.fn(),
  };
  return { ...render(<Chat {...props} />), props };
}

describe("Chat", () => {
  it("connects with the chat id and wires Roll back to the approval, naming the checkpoint", async () => {
    serveCheckpoints();
    hooks.chat.messages = [assistant(previewPart, rollbackPart("p-1"))];
    renderChat();
    expect(hooks.useAgent).toHaveBeenCalledWith({ agent: "BilincAgent", name: CHAT });
    expect(await screen.findByText("Before tea change")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    expect(hooks.chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: "appr-2", approved: true });
  });

  it("sends a plain Reject as a denial and a Reject with a reason as an ordinary tool output", () => {
    serveCheckpoints();
    hooks.chat.messages = [assistant(previewPart, rollbackPart("p-1"))];
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(hooks.chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: "appr-2", approved: false });
    fireEvent.change(screen.getByLabelText("Reason for rejecting (optional)"), { target: { value: "keep red" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    // No state: the hook sends autoContinue false for "output-error", which left the chat without a reply.
    expect(hooks.chat.addToolOutput).toHaveBeenCalledWith({
      toolCallId: "c2",
      toolName: "bilinc_rollback",
      output: rejectedByUserOutput("keep red"),
    });
  });

  it("offers no Roll back when the preview ids differ", () => {
    serveCheckpoints();
    hooks.chat.messages = [assistant(previewPart, rollbackPart("p-other"))];
    renderChat();
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("asks before forgetting, with a Forget button", () => {
    serveCheckpoints();
    hooks.chat.messages = [assistant(forgetPart)];
    renderChat();
    expect(screen.getByText("old-fact")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(hooks.chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: "appr-3", approved: true });
  });

  it("calls onNewChat and reports a failed turn", () => {
    serveCheckpoints();
    hooks.chat.status = "error";
    const { props } = renderChat();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(props.onNewChat).toHaveBeenCalledOnce();
    expect(props.onFailure).toHaveBeenCalledOnce();
  });

  it("sends no model before the chat's state arrives, then the stored choice", async () => {
    serveCheckpoints();
    const { rerender, props } = renderChat();
    await screen.findByRole("button", { name: /^Model:/ });
    expect(hooks.chatOptions?.body?.()).toEqual({});
    hooks.agentState = { model: "@cf/openai/gpt-oss-120b", effort: "high" };
    rerender(<Chat {...props} />);
    await waitFor(() => expect(hooks.chatOptions?.body?.()).toEqual({ model: "@cf/openai/gpt-oss-120b", effort: "high" }));
  });

  it("sends the model choice in the chat body once the state arrived, and follows the selector before it", async () => {
    serveCheckpoints();
    hooks.agentState = { model: null, effort: null };
    renderChat();
    await waitFor(() => expect(hooks.chatOptions?.body?.()).toEqual({ model: "@cf/openai/gpt-oss-120b", effort: "medium" }));
    cleanup();
    hooks.agentState = undefined;
    renderChat();
    expect(hooks.chatOptions?.body?.()).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    fireEvent.click(screen.getByRole("radio", { name: /llama-4-scout/ }));
    expect(hooks.chatOptions?.body?.()).toEqual({ model: "@cf/meta/llama-4-scout-17b-16e-instruct", effort: null });
  });

  it("starts the selector from the chat's stored choice", async () => {
    serveCheckpoints();
    hooks.agentState = { model: "@cf/meta/llama-4-scout-17b-16e-instruct", effort: null };
    renderChat();
    expect(await screen.findByRole("button", { name: "Model: llama-4-scout. Change" })).toBeTruthy();
  });

  it("sends with Enter, and stops with Stop while a turn runs", () => {
    serveCheckpoints();
    const { unmount } = renderChat();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(hooks.chat.sendMessage).toHaveBeenCalledWith({ text: "hello" });
    unmount();
    hooks.chat.status = "streaming";
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(hooks.chat.stop).toHaveBeenCalledOnce();
  });

  it("re-checks /api/health instead of showing unreachable when a checkpoints read fails, and keeps the list", async () => {
    let body: unknown = CHECKPOINTS;
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { props } = renderChat();
    await waitFor(() => expect(props.onBilincState).toHaveBeenCalledTimes(0));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    body = { state: "unreachable", checkpoints: [], now: null };
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(props.onFailure).toHaveBeenCalledOnce());
    expect(props.onBilincState).not.toHaveBeenCalled();
    expect(await screen.findByText("Before tea change")).toBeTruthy();
  });

  it("updates the banner only for a key problem found by the checkpoints read", async () => {
    serveCheckpoints({ state: "key_invalid", checkpoints: [], now: null });
    const { props } = renderChat();
    await waitFor(() => expect(props.onBilincState).toHaveBeenCalledWith("key_invalid"));
    expect(props.onFailure).not.toHaveBeenCalled();
  });

  it("refreshes the checkpoints after a turn that ran a bilinc tool", async () => {
    const fetchMock = serveCheckpoints();
    hooks.chat.status = "streaming";
    const { rerender, props } = renderChat();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    hooks.chat.messages = [assistant(previewPart)];
    hooks.chat.status = "ready";
    rerender(<Chat {...props} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/checkpoints")).toBe(true);
  });

  it("fills the composer from History without sending, and the memory chip sends nothing", async () => {
    serveCheckpoints();
    hooks.chat.messages = [
      assistant(
        {
          type: "tool-search_context",
          toolCallId: "s1",
          state: "output-available",
          input: {},
          output: "Entries\n<<<entry key=favourite-tea v=v1_5fff2a9 updated=2026-11-24\nThe user's favourite tea is Rooibos.\n>>>",
        },
        { type: "text", text: "Your favourite tea is Rooibos." },
      ),
    ];
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "favourite-tea · v1_5fff" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: /Before tea change/ }));
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(box.value).toBe('Diff against the checkpoint "Before tea change".');
    expect(document.activeElement).toBe(box);
    expect(hooks.chat.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves an unreachable /api/checkpoints to /api/health, and History says it cannot read them", async () => {
    serveCheckpoints({ state: "unreachable", checkpoints: [], now: null });
    const { props } = renderChat();
    await waitFor(() => expect(props.onFailure).toHaveBeenCalled());
    expect(props.onBilincState).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText("Checkpoints cannot be read right now.")).toBeTruthy();
  });

  it("reports a session that ended, from /api/checkpoints", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })));
    const { props } = renderChat();
    await waitFor(() => expect(props.onFailure).toHaveBeenCalled());
  });

  it("switches to the phone layout at 640 px and below", () => {
    serveCheckpoints();
    let onChange: (() => void) | undefined;
    const mql = {
      matches: true,
      addEventListener: (_type: string, listener: () => void) => {
        onChange = listener;
      },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("matchMedia", vi.fn(() => mql));
    const { container } = renderChat();
    expect(container.querySelector(".app")?.className).toBe("app is-phone");
    mql.matches = false;
    act(() => onChange?.());
    expect(container.querySelector(".app")?.className).toBe("app");
  });
});
