import { useEffect, useState } from "react";

/** performance.now(), refreshed every `intervalMs` while `active`. Timers keep counting under reduced motion. */
export function useNow(active: boolean, intervalMs = 100): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(performance.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
