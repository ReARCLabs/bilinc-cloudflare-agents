import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_PLACEHOLDER, Composer } from "../src/client/Composer";
import { applyAction, MEMORY_ACTIONS } from "../src/client/memory-actions";

afterEach(cleanup);

/** The composer with the state ChatScreen gives it. */
function Harness(p: { busy?: boolean; onSend?: (text: string) => void; onStop?: () => void }) {
  const [draft, setDraft] = useState("");
  const [tick, setTick] = useState(0);
  return (
    <Composer
      draft={draft}
      onDraft={setDraft}
      focusTick={tick}
      onFill={(text) => {
        setDraft(text);
        setTick((n) => n + 1);
      }}
      busy={p.busy ?? false}
      onSend={(text) => {
        p.onSend?.(text);
        setDraft("");
      }}
      onStop={p.onStop ?? (() => {})}
    />
  );
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

describe("memory actions", () => {
  it("lists the five actions with the spec notes", () => {
    expect(MEMORY_ACTIONS.map((a) => a.name)).toEqual(["Remember", "Recall", "Checkpoint", "Compare", "Roll back"]);
    expect(MEMORY_ACTIONS[2]!.note).toContain("2 credits");
    expect(MEMORY_ACTIONS[4]!.note).toContain("asks you first");
  });

  it("prefixes or sets intent text, and nothing more", () => {
    const [remember, recall, checkpoint] = MEMORY_ACTIONS;
    expect(applyAction("my tea is green", remember!)).toBe("Remember that my tea is green");
    expect(applyAction("Remember that my tea is green", remember!)).toBe("Remember that my tea is green");
    expect(applyAction("/", recall!)).toBe("What do you remember about ");
    expect(applyAction("anything", checkpoint!)).toBe("Checkpoint now.");
  });
});

describe("Composer", () => {
  it("has the spec placeholder and grows from 56 px", () => {
    render(<Harness />);
    expect(box().placeholder).toBe(COMPOSER_PLACEHOLDER);
    expect(COMPOSER_PLACEHOLDER).toBe("Ask anything, or type / for memory actions");
    expect(box().style.height).toBe("56px");
  });

  it("sends the trimmed text on Enter and keeps Shift+Enter for a new line", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.change(box(), { target: { value: "  hello  " } });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(box().value).toBe("");
  });

  it("does not send an empty message, and marks Ask disabled", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const ask = screen.getByRole("button", { name: "Ask" });
    expect(ask.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(ask);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows Stop while a turn runs; Stop and Escape both stop it", () => {
    const onStop = vi.fn();
    render(<Harness busy onStop={onStop} />);
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("opens the Memory menu from the pill and from / in an empty box, focusing the first action", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(5);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(box());
    fireEvent.keyDown(box(), { key: "/" });
    expect(screen.getByRole("menu", { name: "Memory actions" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  });

  it("picks an action with its number key: fills the composer, shows the band, never sends", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "3" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(box().value).toBe("Checkpoint now.");
    expect(document.activeElement).toBe(box());
    expect(screen.getByText("Checkpoint: a point you can return to · 2 credits")).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps typed text after Remember, and Change / opens the menu again", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "my tea is green" } });
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Remember/ }));
    expect(box().value).toBe("Remember that my tea is green");
    fireEvent.click(screen.getByRole("button", { name: "Change /" }));
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("moves through the menu with the arrow keys, wrapping at both ends", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    const items = screen.getAllByRole("menuitem");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[4]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
  });
});
