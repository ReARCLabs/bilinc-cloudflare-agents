import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { defaultEffort, type Effort, type ModelChoice, type ModelEntry } from "../models";
import { Icon } from "./icons";
import { useDismiss } from "./use-dismiss";

export const EFFORT_TEXT: Record<Effort, { name: string; hint: string }> = {
  low: { name: "Low", hint: "Answers fast; light reasoning." },
  medium: { name: "Medium", hint: "Balanced. Good for most chats." },
  high: { name: "High", hint: "Thinks longer before using tools. Slower, more neurons." },
};

/** The round mark: the first letter or digit of the label, upper-cased. */
export function modelMark(model: ModelEntry): string {
  return (model.label.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
}

/** The level a model runs at: the wanted level if it lists it, else its default; null without effort. */
function effortFor(model: ModelEntry, wanted: Effort | null): Effort | null {
  if (!model.effort) return null;
  return wanted && model.effort.includes(wanted) ? wanted : defaultEffort(model);
}

/**
 * Kokonut AI Model Selector pattern, rebuilt: a trigger with mark, name, effort bars and label;
 * a panel that opens upward with a radio list and a Reasoning track (role="slider"). Only models
 * from MODELS are listed, and the Worker checks the choice again on every turn.
 */
export function ModelSelector(p: { models: ModelEntry[]; choice: ModelChoice; onChange(choice: ModelChoice): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const radios = useRef<HTMLDivElement>(null);
  const reasoningId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, [wrap], close, trigger);

  useEffect(() => {
    if (open) radios.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const current = p.models.find((m) => m.id === p.choice.model) ?? p.models[0];
  if (!current) return null;
  const effort = effortFor(current, p.choice.effort);
  const levels = current.effort;
  const level = levels && effort ? levels.indexOf(effort) : -1;

  const pickModel = (model: ModelEntry) => p.onChange({ model: model.id, effort: effortFor(model, effort) });
  const setEffort = (next: Effort) => p.onChange({ model: current.id, effort: next });

  function onRadioKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = p.models.findIndex((m) => m.id === current.id);
    const nextIndex = (index + step + p.models.length) % p.models.length;
    pickModel(p.models[nextIndex]!);
    event.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")[nextIndex]?.focus();
  }

  function onTrackKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!levels) return;
    let next = level;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, level - 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(levels.length - 1, level + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = levels.length - 1;
    else return;
    event.preventDefault();
    if (next !== level) setEffort(levels[next]!);
  }

  const triggerLabel = `Model: ${current.label}${effort ? `, ${EFFORT_TEXT[effort].name} reasoning` : ""}. Change`;

  return (
    <div className="msel" ref={wrap}>
      {open && (
        <div className="mpanel" role="dialog" aria-label="Model">
          <div ref={radios} role="radiogroup" aria-label="Model" onKeyDown={onRadioKey}>
            {p.models.map((model) => {
              const checked = model.id === current.id;
              return (
                <button key={model.id} type="button" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} className="mrow" onClick={() => pickModel(model)}>
                  <span className="mk" aria-hidden="true">
                    {modelMark(model)}
                  </span>
                  <span className="mrow-text">
                    <b>
                      {model.label}
                      {model.tag && <span className="tag">{model.tag}</span>}
                    </b>
                    {model.note && <small>{model.note}</small>}
                  </span>
                  {checked && <Icon name="check" className="ck" />}
                </button>
              );
            })}
          </div>
          {levels && effort && (
            <>
              <div className="hr" />
              <div className="eff">
                <div className="effh">
                  <span id={reasoningId}>Reasoning</span>
                  <small>← → to adjust</small>
                </div>
                <div
                  className="track"
                  role="slider"
                  tabIndex={0}
                  aria-labelledby={reasoningId}
                  aria-valuemin={0}
                  aria-valuemax={levels.length - 1}
                  aria-valuenow={level}
                  aria-valuetext={EFFORT_TEXT[effort].name}
                  onKeyDown={onTrackKey}
                >
                  <span className="thumb" style={{ width: `calc((100% - 4px) / ${levels.length})`, transform: `translateX(${level * 100}%)` }} />
                  {levels.map((l) => (
                    <span key={l} className={l === effort ? "lvl on" : "lvl"} onClick={() => setEffort(l)}>
                      {EFFORT_TEXT[l].name}
                    </span>
                  ))}
                </div>
                <p className="ehint">{EFFORT_TEXT[effort].hint}</p>
              </div>
            </>
          )}
        </div>
      )}
      <button
        ref={trigger}
        type="button"
        className={open ? "mtrig open" : "mtrig"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {/* The mark is drawn from data-mark by CSS and a space separates the visible words, so the
            button's visible text is a run of words of its accessible name (axe label-content-name-mismatch). */}
        <span className="mk" aria-hidden="true" data-mark={modelMark(current)} />
        <span className="mname">{current.label}</span>{" "}
        {levels && effort && (
          <>
            <span className="eg" aria-hidden="true">
              {levels.map((l, i) => (
                <i key={l} className={i <= level ? "on" : ""} style={{ height: `${Math.round((12 * (i + 1)) / levels.length)}px`, transitionDelay: `${i * 30}ms` }} />
              ))}
            </span>
            <span className="elab">{EFFORT_TEXT[effort].name}</span>
          </>
        )}
        <Icon name="caretDown" size={12} className="chev2" />
      </button>
    </div>
  );
}
