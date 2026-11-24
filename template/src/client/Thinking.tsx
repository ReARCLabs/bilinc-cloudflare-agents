import { useState } from "react";
import { formatElapsed } from "./format";
import { useNow } from "./use-now";

/** Animation delays (ms) of the 3×3 grid, row by row: a wavefront that drives across it. Rebuilt from scratch (see NOTICE). */
export const THINKING_DELAYS = [90, 180, 270, 0, 90, 180, 90, 180, 270] as const;

/** Shown while the model works and no step runs: pixel grid, shimmering label, elapsed timer. */
export function Thinking() {
  const [start] = useState(() => performance.now());
  const now = useNow(true);
  return (
    <div className="think" role="status">
      <span className="pg" aria-hidden="true">
        {THINKING_DELAYS.map((delay, i) => (
          <i key={i} style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      <span className="shim">Thinking</span>
      <span className="el" aria-hidden="true">
        {formatElapsed(now - start)}
      </span>
    </div>
  );
}
