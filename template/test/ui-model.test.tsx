import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseModels, type AgentUiState, type ModelChoice, type ModelsConfig } from "../src/models";
import { EFFORT_TEXT, ModelSelector } from "../src/client/ModelSelector";
import { useModelChoice } from "../src/client/use-model-choice";

const BIG = "@cf/openai/gpt-oss-120b";
const SMALL = "@cf/openai/gpt-oss-20b";
const NO_EFFORT = "@cf/example/no-reasoning-model";
const RAW = [
  { id: BIG, label: "gpt-oss-120b", note: "Default. Reliable with memory tools", tag: "tested", effort: ["low", "medium", "high"] },
  { id: SMALL, label: "gpt-oss-20b", note: "Smaller and faster", tag: "tested", effort: ["low", "medium", "high"] },
  { id: NO_EFFORT, label: "no-reasoning-model", note: "No reasoning control", tag: "tested", effort: null },
];
const CONFIG: ModelsConfig = parseModels(RAW, BIG);

afterEach(cleanup);

function Harness(p: { initial?: ModelChoice; onChange?: (choice: ModelChoice) => void }) {
  const [choice, setChoice] = useState<ModelChoice>(p.initial ?? { model: BIG, effort: "medium" });
  return (
    <>
      <ModelSelector
        models={CONFIG.models}
        choice={choice}
        onChange={(next) => {
          p.onChange?.(next);
          setChoice(next);
        }}
      />
      <button type="button">outside</button>
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: /^Model:/ });

describe("ModelSelector", () => {
  it("names the model and the effort on the trigger, with effort bars", () => {
    render(<Harness />);
    expect(trigger().getAttribute("aria-label")).toBe("Model: gpt-oss-120b, Medium reasoning. Change");
    expect(trigger().querySelectorAll(".eg i.on")).toHaveLength(2);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a radio list with notes and tags and focuses the checked model", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    expect(screen.getByRole("dialog", { name: "Model" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(radios[0]!.textContent).toContain("tested");
    expect(radios[1]!.textContent).toContain("Smaller and faster");
    expect(document.activeElement).toBe(radios[0]);
  });

  it("shows no tag badge for a model without a tag", () => {
    const untagged = parseModels(RAW.map(({ tag: _tag, ...rest }) => rest), BIG);
    render(<ModelSelector models={untagged.models} choice={{ model: BIG, effort: "medium" }} onChange={() => {}} />);
    fireEvent.click(trigger());
    expect(screen.getByRole("dialog", { name: "Model" }).querySelector(".tag")).toBeNull();
    expect(screen.getAllByRole("radio")[0]!.textContent).not.toContain("tested");
  });

  it("keeps the effort when the new model lists it, and hides the track for a model without effort", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ model: BIG, effort: "high" }} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("radio", { name: /gpt-oss-20b/ }));
    expect(onChange).toHaveBeenLastCalledWith({ model: SMALL, effort: "high" });
    fireEvent.click(screen.getByRole("radio", { name: /no-reasoning-model/ }));
    expect(onChange).toHaveBeenLastCalledWith({ model: NO_EFFORT, effort: null });
    expect(screen.queryByRole("slider")).toBeNull();
    expect(trigger().getAttribute("aria-label")).toBe("Model: no-reasoning-model. Change");
  });

  it("moves the radio selection with the arrow keys", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith({ model: SMALL, effort: "medium" });
    expect(document.activeElement).toBe(screen.getAllByRole("radio")[1]);
  });

  it("sets the reasoning effort with the slider keys and shows the level's hint", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    const slider = screen.getByRole("slider", { name: "Reasoning" });
    expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith({ model: BIG, effort: "high" });
    expect(slider.getAttribute("aria-valuetext")).toBe("High");
    expect(screen.getByText(EFFORT_TEXT.high.hint)).toBeTruthy();
    fireEvent.keyDown(slider, { key: "Home" });
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.click(within(slider).getByText("Medium"));
    expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  });

  it("closes on Escape with focus back on the trigger, and on a press outside", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Model" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("dialog", { name: "Model" })).toBeNull();
  });
});

describe("useModelChoice", () => {
  function Probe(p: { config: ModelsConfig | null; server?: AgentUiState }) {
    const [choice, setChoice] = useModelChoice(p.config, p.server);
    return (
      <button type="button" onClick={() => setChoice({ model: NO_EFFORT, effort: null })}>
        {choice ? `${choice.model} ${choice.effort}` : "none"}
      </button>
    );
  }

  it("starts from the chat's stored choice or the default, then keeps the user's pick", () => {
    const { rerender } = render(<Probe config={null} />);
    expect(screen.getByRole("button").textContent).toBe("none");
    rerender(<Probe config={CONFIG} />);
    expect(screen.getByRole("button").textContent).toBe(`${BIG} medium`);
    rerender(<Probe config={CONFIG} server={{ model: SMALL, effort: "low" }} />);
    expect(screen.getByRole("button").textContent).toBe(`${SMALL} low`);
    fireEvent.click(screen.getByRole("button"));
    rerender(<Probe config={CONFIG} server={{ model: BIG, effort: "high" }} />);
    expect(screen.getByRole("button").textContent).toBe(`${NO_EFFORT} null`);
  });
});
