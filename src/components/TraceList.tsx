import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";
import { useCanStore } from "../stores/canStore";
import { TraceManager } from "./TraceManager";
import { ChevronDownIcon } from "./icons";

const ROW_HEIGHT = 22;

/**
 * Chronological trace view: virtualized so multi-hundred-thousand-frame
 * traces scroll smoothly. Auto-follows the tail while pinned to the bottom.
 */
export function TraceList() {
  const traceMessages = useCanStore((s) => s.traceMessages);
  const messageNames = useCanStore((s) => s.messageNames);
  const nets = useCanStore(useShallow((s) => s.nets));
  const isRecording = useCanStore((s) => s.isRecording);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [followTail, setFollowTail] = useState(true);

  const virtualizer = useVirtualizer({
    count: traceMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Auto-scroll to the newest frame while following
  useEffect(() => {
    if (followTail && traceMessages.length > 0) {
      virtualizer.scrollToIndex(traceMessages.length - 1, { align: "end" });
    }
  }, [traceMessages.length, followTail, virtualizer]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 3;
    setFollowTail(atBottom);
  };

  const netName = (id: string) => nets.find((n) => n.id === id)?.name ?? id;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="h-9 px-3 flex items-center justify-between border-b border-can-border bg-can-bg-secondary shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-can-text-secondary">
          Trace
          {isRecording && <span className="ml-2 text-can-accent-red normal-case">● recording</span>}
        </span>
        <span className="text-xs text-can-text-muted">
          {traceMessages.length.toLocaleString()} frames
        </span>
      </div>

      <div className="flex border-b border-can-border shrink-0">
        <TraceManager />
      </div>

      {/* Column headers */}
      <div className="flex px-2 h-6 items-center text-xxs font-semibold uppercase tracking-wider text-can-text-muted border-b border-can-border bg-can-bg-secondary shrink-0">
        <span className="w-24 shrink-0">Time</span>
        <span className="w-20 shrink-0">Net</span>
        <span className="w-10 shrink-0">Dir</span>
        <span className="w-24 shrink-0">ID</span>
        <span className="w-44 shrink-0">Name</span>
        <span className="w-10 shrink-0">DLC</span>
        <span className="flex-1">Data</span>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-auto relative">
        {traceMessages.length === 0 ? (
          <div className="text-center py-10 text-can-text-muted text-sm">
            No trace frames. Start recording or load a trace file.
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const frame = traceMessages[item.index];
              if (!frame) return null;
              const idHex = frame.isExtended
                ? `0x${frame.id.toString(16).toUpperCase().padStart(8, "0")}`
                : `0x${frame.id.toString(16).toUpperCase().padStart(3, "0")}`;
              const name = messageNames.get(frame.channel)?.get(frame.id) ?? "";
              return (
                <div
                  key={item.key}
                  className={`flex px-2 items-center text-xs font-mono absolute left-0 right-0 hover:bg-can-bg-tertiary ${
                    frame.direction === "tx" ? "text-can-accent-amber" : "text-can-text-primary"
                  }`}
                  style={{ top: item.start, height: ROW_HEIGHT }}
                >
                  <span className="w-24 shrink-0 text-can-text-secondary">
                    {frame.timestamp.toFixed(4)}
                  </span>
                  <span className="w-20 shrink-0 truncate font-sans text-can-text-secondary">
                    {netName(frame.channel)}
                  </span>
                  <span className="w-10 shrink-0 uppercase text-xxs">{frame.direction}</span>
                  <span className={`w-24 shrink-0 ${frame.isExtended ? "text-can-accent-purple" : ""}`}>
                    {idHex}
                  </span>
                  <span className="w-44 shrink-0 truncate font-sans font-medium">{name}</span>
                  <span className="w-10 shrink-0">{frame.dlc}</span>
                  <span className="flex-1 truncate">
                    {frame.data
                      .slice(0, frame.dlc)
                      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
                      .join(" ")}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {!followTail && traceMessages.length > 0 && (
          <button
            onClick={() => {
              setFollowTail(true);
              virtualizer.scrollToIndex(traceMessages.length - 1, { align: "end" });
            }}
            className="sticky bottom-3 left-1/2 -translate-x-1/2 btn btn-secondary text-xs shadow-lg flex items-center gap-1"
          >
            <ChevronDownIcon className="w-3 h-3" />
            Scroll to bottom
          </button>
        )}
      </div>
    </div>
  );
}
