import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { useCanStore, MonitorEntry } from "../stores/canStore";
import { MagnifyingGlassIcon } from "./icons";
import { TraceManager } from "./TraceManager";
import { invoke } from "@tauri-apps/api/core";

interface DecodedSignal {
  name: string;
  rawValue: number;
  physicalValue: number;
  unit: string;
  valueName?: string;
}

export function MessageViewer() {
  const { traceMessages, monitorMessages, viewMode, idFilter, setIdFilter, isPaused, getDisplayMessages, loadedDbcFiles } = useCanStore();
  
  // Get messages based on current view mode
  // Optimize: only recalculate when relevant data changes based on view mode
  const entries = useMemo(() => {
    if (viewMode === "monitor") {
      // Monitor mode: only use monitorMessages, ignore traceMessages completely
      return Array.from(monitorMessages.values()).sort((a, b) => a.frame.id - b.frame.id);
    } else {
      // Trace mode: use traceMessages, but limit to prevent performance issues
      const maxMessages = 10000; // Use same limit as maxMessages in store
      const messagesToShow = traceMessages.length > maxMessages
        ? traceMessages.slice(-maxMessages)
        : traceMessages;
      
      return messagesToShow.map(frame => ({
        frame,
        count: 0,
        cycleTime: 0,
        lastTimestamp: frame.timestamp,
      }));
    }
  }, [
    // Only depend on monitorMessages in monitor mode
    viewMode === "monitor" ? monitorMessages : null,
    // Only depend on traceMessages.length in trace mode (not the full array)
    viewMode === "trace" ? traceMessages.length : 0,
    viewMode
  ]);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  
  // Navigation and expansion state
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [expandedRowIndex, setExpandedRowIndex] = useState<number | null>(null);
  const [expandedSignals, setExpandedSignals] = useState<DecodedSignal[]>([]);
  
  // Message name cache: channelId-messageId -> message name
  const [messageNameCache, setMessageNameCache] = useState<Map<string, string>>(new Map());
  
  // Column widths state - monitor mode: [Time, Dir, ID, Name, Count, Cycle, DLC, Data, Channel]
  // trace mode: [Time, Dir, ID, Name, DLC, Data, Channel]
  const [columnWidths, setColumnWidths] = useState<number[]>(() => {
    return viewMode === "monitor" 
      ? [10, 6, 8, 15, 6, 8, 5, 25, 7]
      : [12, 7, 10, 18, 6, 30, 7];
  });
  
  // Update column widths when view mode changes
  useEffect(() => {
    setColumnWidths(viewMode === "monitor" 
      ? [10, 6, 8, 15, 6, 8, 5, 25, 7]
      : [12, 7, 10, 18, 6, 30, 7]);
  }, [viewMode]);

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

  // Fetch message name from DBC
  const getMessageName = useCallback(async (channelId: string, messageId: number): Promise<string | null> => {
    const cacheKey = `${channelId}-${messageId}`;
    
    // Check cache first
    if (messageNameCache.has(cacheKey)) {
      return messageNameCache.get(cacheKey) || null;
    }
    
    // Check if DBC is loaded for this channel
    if (!loadedDbcFiles.has(channelId)) {
      return null;
    }
    
    try {
      const messageInfo = await invoke<{ name: string } | null>("get_message_info", {
        channelId,
        messageId,
      });
      
      const name = messageInfo?.name || null;
      
      // Update cache
      setMessageNameCache(prev => {
        const newCache = new Map(prev);
        if (name) {
          newCache.set(cacheKey, name);
        }
        return newCache;
      });
      
      return name;
    } catch (error) {
      console.error("Failed to get message info:", error);
      return null;
    }
  }, [loadedDbcFiles, messageNameCache]);

  // Decode message signals
  const decodeMessageSignals = useCallback(async (channelId: string, messageId: number, data: number[]): Promise<DecodedSignal[]> => {
    if (!loadedDbcFiles.has(channelId)) {
      return [];
    }
    
    try {
      const signals = await invoke<DecodedSignal[]>("decode_message", {
        channelId,
        messageId,
        data,
      });
      return signals;
    } catch (error) {
      console.error("Failed to decode message:", error);
      return [];
    }
  }, [loadedDbcFiles]);

  // Keyboard navigation handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if table container is focused or if no input is focused
      const activeElement = document.activeElement;
      if (activeElement && (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA")) {
        return;
      }
      
      if (filteredEntries.length === 0) return;
      
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setSelectedRowIndex(prev => {
            if (prev === null || prev === 0) {
              return 0;
            }
            return prev - 1;
          });
          break;
          
        case "ArrowDown":
          e.preventDefault();
          setSelectedRowIndex(prev => {
            if (prev === null) {
              return 0;
            }
            if (prev >= filteredEntries.length - 1) {
              return filteredEntries.length - 1;
            }
            return prev + 1;
          });
          break;
          
        case "ArrowRight":
          e.preventDefault();
          if (selectedRowIndex !== null) {
            const entry = filteredEntries[selectedRowIndex];
            if (entry && expandedRowIndex !== selectedRowIndex) {
              // Expand this row
              setExpandedRowIndex(selectedRowIndex);
              // Decode signals
              decodeMessageSignals(entry.frame.channel, entry.frame.id, entry.frame.data)
                .then(signals => setExpandedSignals(signals));
            }
          }
          break;
          
        case "ArrowLeft":
          e.preventDefault();
          if (expandedRowIndex !== null) {
            setExpandedRowIndex(null);
            setExpandedSignals([]);
          }
          break;
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredEntries, selectedRowIndex, expandedRowIndex, decodeMessageSignals]);

  // Scroll selected row into view
  useEffect(() => {
    if (selectedRowIndex !== null && tableContainerRef.current) {
      const rowElement = tableContainerRef.current.querySelector(
        `tbody tr[data-row-index="${selectedRowIndex}"]`
      ) as HTMLElement;
      
      if (rowElement) {
        rowElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }, [selectedRowIndex]);

  // Reset selection when entries change significantly
  useEffect(() => {
    if (selectedRowIndex !== null && selectedRowIndex >= filteredEntries.length) {
      setSelectedRowIndex(Math.max(0, filteredEntries.length - 1));
    }
  }, [filteredEntries.length, selectedRowIndex]);

  // Column resize handler
  const handleResize = useCallback((e: React.MouseEvent, columnIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidths = [...columnWidths];
    const table = tableContainerRef.current?.querySelector('table');
    if (!table) return;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const diff = moveEvent.clientX - startX;
      const tableWidth = table.offsetWidth;
      const diffPercent = (diff / tableWidth) * 100;
      
      const newWidths = [...startWidths];
      newWidths[columnIndex] = Math.max(3, startWidths[columnIndex] + diffPercent);
      
      // Adjust next column to compensate
      if (columnIndex < newWidths.length - 1) {
        newWidths[columnIndex + 1] = Math.max(3, startWidths[columnIndex + 1] - diffPercent);
      }
      
      setColumnWidths(newWidths);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [columnWidths]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Trace Management Panel - only visible in trace mode */}
      {viewMode === "trace" && (
        <div className="border-b border-can-border">
          <TraceManager />
        </div>
      )}
      
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
        className="flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={handleScroll}
      >
        <table className="msg-table" style={{ tableLayout: "fixed", width: "100%" }}>
          <colgroup>
            {viewMode === "monitor" ? (
              // Monitor mode: all 9 columns
              columnWidths.map((width, idx) => (
                <col key={idx} style={{ width: `${width}%` }} />
              ))
            ) : (
              // Trace mode: 7 columns (skip Count and Cycle)
              columnWidths.map((width, idx) => (
                <col key={idx} style={{ width: `${width}%` }} />
              ))
            )}
          </colgroup>
          <thead>
            <tr>
              <th className="relative group">
                Time
                <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/70 group-hover:bg-can-accent-blue/50" 
                     onMouseDown={(e) => handleResize(e, 0)} />
              </th>
              <th className="relative group">
                Dir
                <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/70 group-hover:bg-can-accent-blue/50" 
                     onMouseDown={(e) => handleResize(e, 1)} />
              </th>
              <th className="relative group">
                ID
                <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/70 group-hover:bg-can-accent-blue/50" 
                     onMouseDown={(e) => handleResize(e, 2)} />
              </th>
              <th className="relative group">
                Message Name
                <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/70 group-hover:bg-can-accent-blue/50" 
                     onMouseDown={(e) => handleResize(e, 3)} />
              </th>
              {viewMode === "monitor" && (
                <th className="relative group">
                  Count
                  <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/70 group-hover:bg-can-accent-blue/50" 
                       onMouseDown={(e) => handleResize(e, 4)} />
                </th>
              )}
              {viewMode === "monitor" && (
                <th className="relative group">
                  Cycle
                  <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/70 group-hover:bg-can-accent-blue/50" 
                       onMouseDown={(e) => handleResize(e, 5)} />
                </th>
              )}
              <th className="relative group">
                DLC
                <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/70 group-hover:bg-can-accent-blue/50" 
                     onMouseDown={(e) => handleResize(e, viewMode === "monitor" ? 6 : 4)} />
              </th>
              <th className="relative group">
                Data
                <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/70 group-hover:bg-can-accent-blue/50" 
                     onMouseDown={(e) => handleResize(e, viewMode === "monitor" ? 7 : 5)} />
              </th>
              <th>
                Channel
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.length === 0 ? (
              <tr>
                <td
                  colSpan={viewMode === "monitor" ? 9 : 7}
                  className="text-center py-12 text-can-text-muted"
                >
                  {entries.length === 0
                    ? "No messages received. Connect to a CAN interface to start capturing."
                    : "No messages match the current filter."}
                </td>
              </tr>
            ) : (
              filteredEntries.map((entry, idx) => (
                <MessageRow 
                  key={`${entry.frame.id}-${entry.frame.direction}-${idx}`} 
                  entry={entry} 
                  rowIndex={idx}
                  showMonitorCols={viewMode === "monitor"}
                  isSelected={selectedRowIndex === idx}
                  isExpanded={expandedRowIndex === idx}
                  expandedSignals={expandedRowIndex === idx ? expandedSignals : []}
                  onGetMessageName={getMessageName}
                  onDecodeSignals={decodeMessageSignals}
                  onSelect={() => setSelectedRowIndex(idx)}
                />
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
  rowIndex: number;
  showMonitorCols: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  expandedSignals: DecodedSignal[];
  onGetMessageName: (channelId: string, messageId: number) => Promise<string | null>;
  onDecodeSignals: (channelId: string, messageId: number, data: number[]) => Promise<DecodedSignal[]>;
  onSelect: () => void;
}

function MessageRow({ entry, rowIndex, showMonitorCols, isSelected, isExpanded, expandedSignals, onGetMessageName, onDecodeSignals: _onDecodeSignals, onSelect }: MessageRowProps) {
  const { frame, count, cycleTime } = entry;
  const { setSelectedMessage, channels } = useCanStore();
  const [messageName, setMessageName] = useState<string | null>(null);
  
  // Fetch message name when component mounts or frame changes
  useEffect(() => {
    let cancelled = false;
    
    onGetMessageName(frame.channel, frame.id).then(name => {
      if (!cancelled) {
        setMessageName(name);
      }
    });
    
    return () => {
      cancelled = true;
    };
  }, [frame.channel, frame.id, onGetMessageName]);
  
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

  const formatChannel = (channelId: string) => {
    if (!channelId) return "-";
    const channel = channels.find(c => c.id === channelId);
    if (channel) {
      // If channel name is different from default "Channel N", use the name
      // Otherwise use the channel number
      const defaultName = `Channel ${channels.indexOf(channel) + 1}`;
      if (channel.name !== defaultName) {
        return channel.name;
      }
      return `${channels.indexOf(channel) + 1}`;
    }
    // Fallback: try to extract number from channel ID
    const match = channelId.match(/channel[_-]?(\d+)/i);
    if (match) {
      return match[1];
    }
    return channelId;
  };

  const handleRowClick = () => {
    onSelect();
    setSelectedMessage(frame);
  };

  return (
    <>
      <tr 
        data-row-index={rowIndex}
        className={`selectable ${isSelected ? "bg-can-bg-hover ring-2 ring-can-accent-blue" : ""}`}
        onClick={handleRowClick}
      >
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
        <td className="text-can-text-primary text-xs truncate" title={messageName || "-"}>
          {messageName || "-"}
        </td>
        {showMonitorCols && (
          <td className="font-mono text-can-accent-yellow">{count.toLocaleString()}</td>
        )}
        {showMonitorCols && (
          <td className="font-mono text-can-text-secondary text-xs">{formatCycleTime(cycleTime)}</td>
        )}
        <td className="font-mono text-can-text-secondary">{frame.dlc}</td>
        <td className="font-mono truncate" title={frame.isRemote ? "Remote frame" : formatData(frame.data, frame.dlc)}>
          {frame.isRemote ? (
            <span className="text-can-text-muted italic">Remote frame</span>
          ) : (
            <span className="tracking-wider">{formatData(frame.data, frame.dlc)}</span>
          )}
        </td>
        <td className="text-can-text-muted text-xs">{formatChannel(frame.channel)}</td>
      </tr>
      {isExpanded && expandedSignals.length > 0 && (
        <tr>
          <td colSpan={showMonitorCols ? 9 : 7} className="bg-can-bg-tertiary p-0">
            <div className="px-4 py-2 border-t border-can-border">
              <div className="space-y-0">
                {expandedSignals.map((signal, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center justify-between text-xs py-1 ${
                      idx < expandedSignals.length - 1 ? "border-b border-can-border" : ""
                    }`}
                  >
                    <span className="font-medium text-can-text-primary">
                      {signal.name}
                    </span>
                    <span className="text-can-accent-yellow">
                      {signal.valueName || (signal.physicalValue != null ? signal.physicalValue.toFixed(3) : "N/A")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

