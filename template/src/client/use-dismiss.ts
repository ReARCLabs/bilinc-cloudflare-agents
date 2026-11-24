import { useEffect, type RefObject } from "react";

const FOCUSABLE = "a, button, input, textarea, select, [tabindex]";

/**
 * While `open`: Escape, or a pointer press outside every element in `inside`, calls `onClose`.
 * Escape returns focus to `returnFocus`, and so does an outside press that lands on nothing
 * focusable. The Escape listener runs in the capture phase and stops the event there, so the
 * composer's own Escape (stop the turn) does not fire as well.
 */
export function useDismiss(
  open: boolean,
  inside: RefObject<HTMLElement | null>[],
  onClose: () => void,
  returnFocus?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      returnFocus?.current?.focus();
    };
    const onPointer = (event: Event) => {
      const target = event.target as Node | null;
      if (target && inside.some((ref) => ref.current?.contains(target))) return;
      onClose();
      if (!(target instanceof Element && target.closest(FOCUSABLE))) returnFocus?.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
    // `inside` and `returnFocus` hold refs, which are stable; only `open` and `onClose` matter.
  }, [open, onClose]);
}
