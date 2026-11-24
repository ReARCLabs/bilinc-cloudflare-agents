import { useEffect, useState } from "react";

export const PHONE_QUERY = "(max-width: 640px)";

function query(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
}

/** True at 640 px and below. The app root gets `is-phone`, and the CSS keys off that class (spec: phone layout). */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mql = query();
    if (!mql) return;
    const onChange = () => setPhone(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return phone;
}
