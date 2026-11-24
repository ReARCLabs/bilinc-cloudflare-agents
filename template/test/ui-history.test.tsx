import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckpointsBody } from "../src/checkpoints";
import { fetchCheckpoints } from "../src/client/api";
import { checkpointTime, checkpointTitle, diffAgainstText, formatElapsed } from "../src/client/format";
import { Header } from "../src/client/Header";
import { HISTORY_EMPTY_TEXT, HistoryButton } from "../src/client/History";

/** Today at hh:mm, local time. */
const today = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const DATA: CheckpointsBody = {
  state: "ok",
  now: { total: 4 },
  checkpoints: [
    { id: "snap_3", label: "Before tea change", createdAt: today(7, 32), totalEntries: 4 },
    { id: "snap_2", label: "auto: chat start 2026-11-24T07:32:00.000Z", createdAt: today(7, 32), totalEntries: 3 },
    { id: "snap_1", label: null, createdAt: today(6, 46), totalEntries: 2 },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("format", () => {
  it("formats elapsed time like the mockup", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(1449)).toBe("1.4s");
    expect(formatElapsed(62_300)).toBe("1m 2.3s");
    expect(formatElapsed(-5)).toBe("0.0s");
  });

  it("titles checkpoints and writes the fill text from the label or the id", () => {
    expect(checkpointTitle(DATA.checkpoints[0]!)).toBe("Before tea change");
    expect(checkpointTitle(DATA.checkpoints[1]!)).toBe("auto · chat start");
    expect(checkpointTitle(DATA.checkpoints[2]!)).toBe("snap_1");
    expect(diffAgainstText(DATA.checkpoints[0]!)).toBe('Diff against the checkpoint "Before tea change".');
    expect(diffAgainstText(DATA.checkpoints[2]!)).toBe('Diff against the checkpoint "snap_1".');
  });

  it("shows the time today and the date on an earlier day", () => {
    const noon = new Date(2026, 10, 24, 12, 0);
    expect(checkpointTime(new Date(2026, 10, 24, 7, 32).toISOString(), noon)).toBe("07:32");
    expect(checkpointTime(new Date(2026, 10, 23, 9, 0).toISOString(), noon)).toBe("Nov 23");
    expect(checkpointTime("not a date", noon)).toBe("");
  });
});

describe("fetchCheckpoints", () => {
  it("maps 401 to locked and keeps a valid body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })));
    expect(await fetchCheckpoints()).toBe("locked");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(DATA), { status: 200 })));
    expect(await fetchCheckpoints()).toEqual(DATA);
  });

  it("throws on a server error and reads a malformed body as unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    await expect(fetchCheckpoints()).rejects.toThrow("/api/checkpoints answered 500");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    expect(await fetchCheckpoints()).toEqual({ state: "unreachable", checkpoints: [], now: null });
  });
});

describe("HistoryButton", () => {
  function open(data: CheckpointsBody | null = DATA) {
    const onOpen = vi.fn();
    const onPick = vi.fn();
    render(<HistoryButton data={data} onOpen={onOpen} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    return { onOpen, onPick };
  }

  it("refreshes on open and lists Now first, then the checkpoints newest first", () => {
    const { onOpen } = open();
    expect(onOpen).toHaveBeenCalledOnce();
    const dialog = screen.getByRole("dialog", { name: "Checkpoints" });
    expect(dialog.querySelector(".hist-row.now")?.textContent).toBe("Now 4 entries");
    const rows = [...dialog.querySelectorAll("button.hist-row")].map((row) => row.textContent);
    expect(rows).toEqual(["Before tea change 07:32", "auto · chat start 07:32", "snap_1 06:46"]);
  });

  it("focuses the newest checkpoint when it opens", () => {
    open();
    expect(document.activeElement?.textContent).toBe("Before tea change 07:32");
  });

  it("fills the composer through onPick, closes, and never sends", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { onPick } = open();
    fireEvent.click(screen.getByRole("button", { name: /Before tea change/ }));
    expect(onPick).toHaveBeenCalledWith('Diff against the checkpoint "Before tea change".');
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says so when there are no checkpoints, and while they load", () => {
    open({ state: "ok", now: { total: 0 }, checkpoints: [] });
    expect(screen.getByText(HISTORY_EMPTY_TEXT)).toBeTruthy();
    cleanup();
    open(null);
    expect(screen.getByText("Loading checkpoints…")).toBeTruthy();
  });

  it("closes on Escape and returns focus to the button", () => {
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "History" }));
  });

  it("closes on a press outside", () => {
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Header", () => {
  it("shows the lockup, the History slot and New chat", () => {
    const onNewChat = vi.fn();
    render(<Header onNewChat={onNewChat} history={<button type="button">History</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Bilinc Memory" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });
});
