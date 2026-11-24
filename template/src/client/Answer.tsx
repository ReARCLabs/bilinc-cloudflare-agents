import { Fragment, useId } from "react";
import { placeChips, type MemoryHit } from "./memory-hits";

/**
 * `key · v1_xxxx` after a sentence backed by a search_context hit. Hover or focus shows the hit's
 * key, version, saved day and value. It has no action: it never sends anything.
 */
export function MemoryChip({ hit }: { hit: MemoryHit }) {
  const tipId = useId();
  const label = hit.version ? `${hit.key} · ${hit.version.slice(0, 7)}` : hit.key;
  return (
    <span className="chip-wrap">
      <button type="button" className="chip" aria-describedby={tipId}>
        {label}
      </button>
      <span role="tooltip" id={tipId} className="chip-tip">
        <span className="mono">{hit.key}</span>
        {hit.version && <span className="mono">{`version ${hit.version}`}</span>}
        {hit.updated && <span>{`saved ${hit.updated}`}</span>}
        <span className="chip-value">{hit.value.slice(0, 240)}</span>
      </span>
    </span>
  );
}

export function Answer({ text, hits }: { text: string; hits: MemoryHit[] }) {
  return (
    <p className="ans">
      {placeChips(text, hits).map((segment, i) =>
        segment.kind === "text" ? <Fragment key={i}>{segment.text}</Fragment> : <MemoryChip key={i} hit={segment.hit} />,
      )}
    </p>
  );
}
