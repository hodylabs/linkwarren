import { useEffect } from "react";

// One shared "unsaved changes" guard: forms holding an edit register here; navigation keys and section switches that would
// drop the edit check hasUnsaved() and stay put instead (S2 ruling: no-ops while a draft is dirty).
const dirty = new Set<symbol>();

/** While `on`, this form holds an unsaved edit. */
export function useUnsaved(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const k = Symbol("unsaved");
    dirty.add(k);
    return () => void dirty.delete(k);
  }, [on]);
}

export const hasUnsaved = (): boolean => dirty.size > 0;
export const UNSAVED = "Unsaved changes: save with Ctrl+Enter or discard with Esc in the form first.";
