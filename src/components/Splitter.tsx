import { useCallback, useEffect, useRef, useState } from "react";

interface SplitterProps {
  /** localStorage key for persisting the split position. */
  storageKey: string;
  /** Top pane height as a percentage (initial/default). */
  defaultPercent?: number;
  minPercent?: number;
  maxPercent?: number;
  top: React.ReactNode;
  bottom: React.ReactNode;
}

/**
 * Vertical stack with a draggable horizontal divider (PCX7-style
 * receive-over-transmit layout). Position persists across sessions.
 */
export function Splitter({
  storageKey,
  defaultPercent = 65,
  minPercent = 20,
  maxPercent = 85,
  top,
  bottom,
}: SplitterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [percent, setPercent] = useState<number>(() => {
    const stored = localStorage.getItem(storageKey);
    const parsed = stored ? parseFloat(stored) : NaN;
    return Number.isFinite(parsed) ? Math.min(maxPercent, Math.max(minPercent, parsed)) : defaultPercent;
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    localStorage.setItem(storageKey, percent.toFixed(2));
  }, [percent, storageKey]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      setPercent(Math.min(maxPercent, Math.max(minPercent, pct)));
    },
    [dragging, minPercent, maxPercent]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    setDragging(false);
  }, []);

  return (
    <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
      <div style={{ height: `${percent}%` }} className="flex flex-col overflow-hidden">
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`h-1.5 shrink-0 cursor-row-resize border-y border-can-border transition-colors ${
          dragging ? "bg-can-accent-blue" : "bg-can-bg-tertiary hover:bg-can-accent-blue/50"
        }`}
      />
      <div className="flex-1 flex flex-col overflow-hidden">{bottom}</div>
    </div>
  );
}
