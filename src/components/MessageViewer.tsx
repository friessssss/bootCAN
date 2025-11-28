import { useMemo, useRef, useEffect, useState } from "react";
import { useCanStore, MonitorEntry } from "../stores/canStore";
import { MagnifyingGlassIcon } from "./icons";

export function MessageViewer() {
  const { traceMessages, monitorMessages, viewMode, idFilter, setIdFilter, isPaused, getDisplayMessages } = useCanStore();
  
  // Get messages based on current view mode
  const entries = useMemo(() => getDisplayMessages(), [traceMessages, monitorMessages, viewMode]);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Filter entries based on ID filter
  const filteredEntries = useMemo(() => {
    if (!idFilter.trim()) return entries;

    const filter = idFilter.toLowerCase().replace("0x", "");
    return entries.filter((entry) => {
      const idHex = entry.frame.id.toString(16).toLowerCase();
      return idHex.includes(filter);
    });
  }, [entries, idFilter]);

  // Auto-scroll to bottom when new messages arrive (only in trace mode)
  useEffect(() => {
    if (autoScroll && tableContainerRef.current && !isPaused && viewMode === "trace") {
      tableContainerRef.current.scrollTop =
        tableContainerRef.current.scrollHeight;
    }
  }, [filteredEntries.length, autoScroll, isPaused, viewMode]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = () => {
    if (!tableContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = tableContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header with Filter */}
      <div className="px-4 py-2 border-b border-can-border flex items-center justify-between bg-can-bg-secondary">
        <div className="flex items-center gap-3">
          <h2 className="panel-title">Messages</h2>
          <span className="text-xs text-can-text-muted">
            {filteredEntries.length.toLocaleString()} {viewMode === "monitor" ? "unique IDs" : "messages"}
            {idFilter && ` (filtered)`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-can-text-muted" />
            <input
              type="text"
              placeholder="Filter by ID (hex)..."
              className="input pl-8 w-48"
              value={idFilter}
              onChange={(e) => setIdFilter(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Message Table */}
      <div
        ref={tableContainerRef}
        className="flex-1 overflow-auto"
        onScroll={handleScroll}
      >
        <table className="msg-table">
          <thead>
            <tr>
              <th className="w-28">Time</th>
              <th className="w-12">Dir</th>
              <th className="w-24">ID</th>
              {viewMode === "monitor" && <th className="w-16">Count</th>}
              {viewMode === "monitor" && <th className="w-20">Cycle</th>}
              <th className="w-12">DLC</th>
              <th className="min-w-[200px]">Data</th>
              <th className="w-20">Channel</th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.length === 0 ? (
              <tr>
                <td
                  colSpan={viewMode === "monitor" ? 8 : 6}
                  className="text-center py-12 text-can-text-muted"
                >
                  {entries.length === 0
                    ? "No messages received. Connect to a CAN interface to start capturing."
                    : "No messages match the current filter."}
                </td>
              </tr>
            ) : (
              filteredEntries.map((entry, idx) => (
                <MessageRow key={`${entry.frame.id}-${entry.frame.direction}-${idx}`} entry={entry} showMonitorCols={viewMode === "monitor"} />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Auto-scroll indicator */}
      {!autoScroll && (
        <button
          className="absolute bottom-20 right-8 btn btn-primary shadow-lg"
          onClick={() => {
            setAutoScroll(true);
            if (tableContainerRef.current) {
              tableContainerRef.current.scrollTop =
                tableContainerRef.current.scrollHeight;
            }
          }}
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
}

interface MessageRowProps {
  entry: MonitorEntry;
  showMonitorCols: boolean;
}

function MessageRow({ entry, showMonitorCols }: MessageRowProps) {
  const { frame, count, cycleTime } = entry;
  
  const formatTimestamp = (ts: number) => {
    return ts.toFixed(6);
  };

  const formatId = (id: number, isExtended: boolean) => {
    const hex = id.toString(16).toUpperCase();
    return isExtended ? hex.padStart(8, "0") : hex.padStart(3, "0");
  };

  const formatData = (data: number[], dlc: number) => {
    return data
      .slice(0, dlc)
      .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
  };

  const formatCycleTime = (ms: number) => {
    if (ms === 0) return "-";
    if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
    if (ms < 1000) return `${ms.toFixed(1)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  };

  return (
    <tr className="selectable">
      <td className="font-mono text-can-text-secondary text-xs">
        {formatTimestamp(frame.timestamp)}
      </td>
      <td>
        <span
          className={`badge ${
            frame.direction === "tx" ? "badge-blue" : "badge-green"
          }`}
        >
          {frame.direction.toUpperCase()}
        </span>
      </td>
      <td className="font-mono">
        <span className="text-can-text-muted">0x</span>
        <span
          className={
            frame.isExtended ? "text-can-accent-purple" : "text-can-text-primary"
          }
        >
          {formatId(frame.id, frame.isExtended)}
        </span>
        {frame.isRemote && (
          <span className="ml-1 text-xxs text-can-accent-yellow">RTR</span>
        )}
      </td>
      {showMonitorCols && (
        <td className="font-mono text-can-accent-yellow">{count.toLocaleString()}</td>
      )}
      {showMonitorCols && (
        <td className="font-mono text-can-text-secondary text-xs">{formatCycleTime(cycleTime)}</td>
      )}
      <td className="font-mono text-can-text-secondary">{frame.dlc}</td>
      <td className="font-mono">
        {frame.isRemote ? (
          <span className="text-can-text-muted italic">Remote frame</span>
        ) : (
          <span className="tracking-wider">{formatData(frame.data, frame.dlc)}</span>
        )}
      </td>
      <td className="text-can-text-muted text-xs">{frame.channel}</td>
    </tr>
  );
}

