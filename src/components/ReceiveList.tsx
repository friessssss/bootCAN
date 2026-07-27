import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { useCanStore } from "../stores/canStore";
import type { DecodedSignal, MonitorEntry, SortKey } from "../types/can";
import { ChevronDownIcon, MagnifyingGlassIcon } from "./icons";
import { useColumnWidths } from "../hooks/useColumnWidths";

const COLUMNS: Array<{ key: SortKey | "data"; label: string; sortable: boolean }> = [
  { key: "name", label: "Name", sortable: true },
  { key: "id", label: "ID", sortable: true },
  { key: "channel", label: "Net", sortable: true },
  { key: "direction", label: "Dir", sortable: true },
  { key: "dlc", label: "DLC", sortable: true },
  { key: "data", label: "Data", sortable: false },
  { key: "cycleTime", label: "Cycle", sortable: true },
  { key: "count", label: "Count", sortable: true },
];
const DEFAULT_WIDTHS = [22, 10, 10, 5, 5, 30, 9, 9];

function monitorKey(e: MonitorEntry): string {
  return `${e.frame.channel}-${e.frame.id}-${e.frame.direction}`;
}

function formatCycle(ms: number): string {
  if (ms <= 0) return "–";
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Decode signals for expanded rows, at most once per data change per row. */
function useExpandedSignals(entries: MonitorEntry[]): Map<string, DecodedSignal[]> {
  const [decoded, setDecoded] = useState<Map<string, DecodedSignal[]>>(new Map());
  const cacheRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const pending: { key: string; entry: MonitorEntry }[] = [];
    for (const entry of entries) {
      const key = monitorKey(entry);
      const dataHex = entry.frame.data.join(",");
      if (cacheRef.current.get(key) !== dataHex) {
        cacheRef.current.set(key, dataHex);
        pending.push({ key, entry });
      }
    }
    if (pending.length === 0) return;

    const requests = pending.map(({ entry }) => ({
      channelId: entry.frame.channel,
      messageId: entry.frame.id,
      data: entry.frame.data,
    }));
    invoke<DecodedSignal[][]>("decode_messages_batch", { requests })
      .then((results) => {
        setDecoded((prev) => {
          const next = new Map(prev);
          results.forEach((signals, i) => next.set(pending[i].key, signals));
          return next;
        });
      })
      .catch(() => {
        // No symbol file for this net — expanded row will show a hint
      });

    // Drop cache entries for rows that are no longer expanded
    const live = new Set(entries.map(monitorKey));
    for (const key of cacheRef.current.keys()) {
      if (!live.has(key)) cacheRef.current.delete(key);
    }
  }, [entries]);

  return decoded;
}

export function ReceiveList() {
  const {
    monitorMessages,
    monitorSort,
    setMonitorSort,
    idFilter,
    setIdFilter,
    messageNames,
    expandedRows,
    toggleRowExpanded,
  } = useCanStore(
    useShallow((s) => ({
      monitorMessages: s.monitorMessages,
      monitorSort: s.monitorSort,
      setMonitorSort: s.setMonitorSort,
      idFilter: s.idFilter,
      setIdFilter: s.setIdFilter,
      messageNames: s.messageNames,
      expandedRows: s.expandedRows,
      toggleRowExpanded: s.toggleRowExpanded,
    }))
  );
  const nets = useCanStore(useShallow((s) => s.nets));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { widths, startResize } = useColumnWidths("receive-cols", DEFAULT_WIDTHS);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard selection visible while arrowing through the list
  useEffect(() => {
    if (!selectedKey || !containerRef.current) return;
    containerRef.current
      .querySelector(`[data-key="${CSS.escape(selectedKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const netName = (id: string) => nets.find((n) => n.id === id)?.name ?? id;
  const nameFor = (entry: MonitorEntry) =>
    messageNames.get(entry.frame.channel)?.get(entry.frame.id) ?? null;

  const entries = useMemo(() => {
    let list = Array.from(monitorMessages.values());
    if (idFilter.trim()) {
      const filter = idFilter.trim().toLowerCase().replace(/^0x/, "");
      list = list.filter((e) => {
        const hex = e.frame.id.toString(16).toLowerCase();
        const name = nameFor(e)?.toLowerCase() ?? "";
        return hex.includes(filter) || name.includes(idFilter.trim().toLowerCase());
      });
    }
    const dir = monitorSort.dir === "asc" ? 1 : -1;
    const key = monitorSort.key;
    list.sort((a, b) => {
      let cmp = 0;
      switch (key) {
        case "name":
          cmp = (nameFor(a) ?? `￿${a.frame.id}`).localeCompare(
            nameFor(b) ?? `￿${b.frame.id}`
          );
          break;
        case "id":
          cmp = a.frame.id - b.frame.id;
          break;
        case "channel":
          cmp = netName(a.frame.channel).localeCompare(netName(b.frame.channel));
          break;
        case "direction":
          cmp = a.frame.direction.localeCompare(b.frame.direction);
          break;
        case "dlc":
          cmp = a.frame.dlc - b.frame.dlc;
          break;
        case "cycleTime":
          cmp = a.cycleTime - b.cycleTime;
          break;
        case "count":
          cmp = a.count - b.count;
          break;
        default:
          cmp = a.frame.id - b.frame.id;
      }
      return cmp * dir;
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorMessages, idFilter, monitorSort, messageNames, nets]);

  const expandedEntries = useMemo(
    () => entries.filter((e) => expandedRows.has(monitorKey(e))),
    [entries, expandedRows]
  );
  const decodedSignals = useExpandedSignals(expandedEntries);

  const handleSort = (key: SortKey) => {
    if (monitorSort.key === key) {
      setMonitorSort({ key, dir: monitorSort.dir === "asc" ? "desc" : "asc" });
    } else {
      setMonitorSort({ key, dir: "asc" });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (entries.length === 0) return;
    const idx = selectedKey ? entries.findIndex((en) => monitorKey(en) === selectedKey) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = entries[Math.min(entries.length - 1, idx + 1)];
      setSelectedKey(monitorKey(next));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = entries[Math.max(0, idx <= 0 ? 0 : idx - 1)];
      setSelectedKey(monitorKey(next));
    } else if ((e.key === "ArrowRight" || e.key === "Enter") && selectedKey) {
      e.preventDefault();
      if (!expandedRows.has(selectedKey)) toggleRowExpanded(selectedKey);
    } else if (e.key === "ArrowLeft" && selectedKey) {
      e.preventDefault();
      if (expandedRows.has(selectedKey)) toggleRowExpanded(selectedKey);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header row: title + filter */}
      <div className="h-9 px-3 flex items-center justify-between border-b border-can-border bg-can-bg-secondary shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-can-text-secondary">
          Receive
        </span>
        <div className="relative">
          <MagnifyingGlassIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-can-text-muted" />
          <input
            type="text"
            value={idFilter}
            onChange={(e) => setIdFilter(e.target.value)}
            placeholder="Filter ID or name…"
            className="input h-6 pl-7 text-xs w-48"
          />
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <table className="msg-table w-full table-fixed">
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: `${w}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col, i) => (
                <th
                  key={col.key}
                  className="relative select-none"
                  onClick={col.sortable ? () => handleSort(col.key as SortKey) : undefined}
                >
                  <span className={col.sortable ? "cursor-pointer hover:text-can-text-primary" : ""}>
                    {col.label}
                    {monitorSort.key === col.key && (
                      <span className="ml-1 text-can-accent-blue">
                        {monitorSort.dir === "asc" ? "▲" : "▼"}
                      </span>
                    )}
                  </span>
                  {i < COLUMNS.length - 1 && (
                    <span
                      onPointerDown={(e) => startResize(i, e)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/40"
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="text-center py-10 text-can-text-muted text-sm">
                  {monitorMessages.size === 0
                    ? "No messages received. Connect a net to start monitoring."
                    : "No messages match the filter."}
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const key = monitorKey(entry);
                const expanded = expandedRows.has(key);
                return (
                  <ReceiveRow
                    key={key}
                    entry={entry}
                    name={nameFor(entry)}
                    netName={netName(entry.frame.channel)}
                    selected={selectedKey === key}
                    expanded={expanded}
                    signals={expanded ? decodedSignals.get(key) : undefined}
                    hasSymbols={messageNames.has(entry.frame.channel)}
                    onClick={() => setSelectedKey(key)}
                    onToggleExpand={() => toggleRowExpanded(key)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RowProps {
  entry: MonitorEntry;
  name: string | null;
  netName: string;
  selected: boolean;
  expanded: boolean;
  signals: DecodedSignal[] | undefined;
  hasSymbols: boolean;
  onClick: () => void;
  onToggleExpand: () => void;
}

const ReceiveRow = memo(function ReceiveRow({
  entry,
  name,
  netName,
  selected,
  expanded,
  signals,
  hasSymbols,
  onClick,
  onToggleExpand,
}: RowProps) {
  const { frame, changedAt } = entry;
  const idHex = frame.isExtended
    ? `0x${frame.id.toString(16).toUpperCase().padStart(8, "0")}`
    : `0x${frame.id.toString(16).toUpperCase().padStart(3, "0")}`;

  const subRowRef = useRef<HTMLTableRowElement>(null);
  const scrolledOnExpand = useRef(false);

  // When a row is expanded (especially near the bottom), bring the signal
  // sub-rows into view once they've rendered.
  useEffect(() => {
    if (!expanded) {
      scrolledOnExpand.current = false;
      return;
    }
    if (!scrolledOnExpand.current && subRowRef.current) {
      // Wait until decoded signals (or the hint) have real height
      scrolledOnExpand.current = true;
      requestAnimationFrame(() => {
        subRowRef.current?.scrollIntoView({ block: "nearest" });
      });
    }
  }, [expanded, signals]);

  return (
    <>
      <tr
        data-key={`${frame.channel}-${frame.id}-${frame.direction}`}
        onClick={onClick}
        onDoubleClick={onToggleExpand}
        className={`cursor-default ${
          selected ? "!bg-can-accent-blue/20" : ""
        } ${frame.direction === "tx" ? "text-can-accent-amber" : ""}`}
      >
        <td className="truncate">
          <span className="inline-flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              className={`p-0.5 rounded text-can-text-muted hover:text-can-text-primary transition-transform ${
                expanded ? "" : "-rotate-90"
              }`}
              title={expanded ? "Collapse signals" : "Expand signals"}
            >
              <ChevronDownIcon className="w-3 h-3" />
            </button>
            {name ? (
              <span className="font-semibold text-can-text-primary truncate">{name}</span>
            ) : (
              <span className="text-can-text-secondary font-mono">{idHex}</span>
            )}
          </span>
        </td>
        <td className={`font-mono ${frame.isExtended ? "text-can-accent-purple" : ""}`}>
          {idHex}
          {frame.isRemote && (
            <span className="ml-1 text-xxs px-1 rounded bg-can-accent-amber/20 text-can-accent-amber">
              RTR
            </span>
          )}
        </td>
        <td className="truncate text-can-text-secondary">{netName}</td>
        <td className="uppercase text-xxs">{frame.direction}</td>
        <td className="font-mono">{frame.dlc}</td>
        <td className="font-mono whitespace-nowrap overflow-hidden">
          {frame.data.slice(0, frame.dlc).map((b, i) => (
            <span
              // Re-keying on changedAt restarts the flash animation on change
              key={`${i}-${changedAt[i] ?? 0}`}
              className={`inline-block w-[2ch] mr-[1ch] ${
                (changedAt[i] ?? 0) > 0 ? "byte-flash" : ""
              }`}
            >
              {b.toString(16).toUpperCase().padStart(2, "0")}
            </span>
          ))}
        </td>
        <td className="font-mono text-can-text-secondary">{formatCycle(entry.cycleTime)}</td>
        <td className="font-mono text-can-text-secondary">{entry.count.toLocaleString()}</td>
      </tr>
      {expanded && (
        <tr ref={subRowRef} className="!bg-can-bg-secondary/60">
          <td colSpan={COLUMNS.length} className="!py-0">
            <SignalSubRows signals={signals} hasSymbols={hasSymbols} />
          </td>
        </tr>
      )}
    </>
  );
});

function SignalSubRows({
  signals,
  hasSymbols,
}: {
  signals: DecodedSignal[] | undefined;
  hasSymbols: boolean;
}) {
  if (!hasSymbols) {
    return (
      <div className="pl-8 py-1.5 text-xs text-can-text-muted italic">
        Attach a symbol file (.sym / .dbc) to this net to decode signals.
      </div>
    );
  }
  if (!signals || signals.length === 0) {
    return (
      <div className="pl-8 py-1.5 text-xs text-can-text-muted italic">
        No signals defined for this message.
      </div>
    );
  }
  return (
    <div className="pl-8 pr-2 py-1">
      {signals.map((sig) => (
        <div
          key={sig.name}
          className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)] gap-2 py-0.5 text-xs border-l-2 border-can-border pl-3"
        >
          <span className="text-can-accent-cyan truncate">{sig.name}</span>
          <span className="font-mono text-can-text-primary truncate">
            {sig.valueName ? (
              <>
                {sig.valueName}
                <span className="text-can-text-muted ml-1">({sig.physicalValue})</span>
              </>
            ) : (
              <>
                {Number.isInteger(sig.physicalValue)
                  ? sig.physicalValue
                  : sig.physicalValue.toFixed(3)}
                {sig.unit && <span className="text-can-text-muted ml-1">{sig.unit}</span>}
              </>
            )}
          </span>
          <span className="font-mono text-can-text-muted truncate">raw: {sig.rawValue}</span>
        </div>
      ))}
    </div>
  );
}
