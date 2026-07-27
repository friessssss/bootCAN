import { useCallback, useRef, useState } from "react";

/**
 * Drag-resizable table column widths (percentages). Dragging a column's right
 * edge trades width with its right neighbor. Persisted to localStorage.
 */
export function useColumnWidths(storageKey: string, defaults: number[]) {
  const [widths, setWidths] = useState<number[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length === defaults.length) return parsed;
      }
    } catch {
      // fall through to defaults
    }
    return defaults;
  });

  const dragState = useRef<{
    index: number;
    startX: number;
    tableWidth: number;
    snapshot: number[];
  } | null>(null);

  const startResize = useCallback(
    (index: number, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const table = (e.target as HTMLElement).closest("table");
      if (!table) return;
      dragState.current = {
        index,
        startX: e.clientX,
        tableWidth: table.getBoundingClientRect().width,
        snapshot: widths.slice(),
      };

      const onMove = (ev: PointerEvent) => {
        const drag = dragState.current;
        if (!drag) return;
        const deltaPct = ((ev.clientX - drag.startX) / drag.tableWidth) * 100;
        const { index: i, snapshot } = drag;
        if (i + 1 >= snapshot.length) return;
        const pair = snapshot[i] + snapshot[i + 1];
        const next = snapshot.slice();
        next[i] = Math.min(pair - 3, Math.max(3, snapshot[i] + deltaPct));
        next[i + 1] = pair - next[i];
        setWidths(next);
      };
      const onUp = () => {
        dragState.current = null;
        setWidths((w) => {
          localStorage.setItem(storageKey, JSON.stringify(w));
          return w;
        });
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [widths, storageKey]
  );

  return { widths, startResize };
}
