import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCanStore } from "../stores/canStore";
import type { TransmitRow } from "../types/can";
import { TransmitEditor } from "./TransmitEditor";
import {
  PaperAirplaneIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "./icons";
import { useColumnWidths } from "../hooks/useColumnWidths";

const DEFAULT_WIDTHS = [4, 18, 9, 10, 5, 24, 8, 8, 14];

/**
 * PCX7-style transmit list: full-width table of transmit messages.
 * Spacebar / send button = one-shot; play/pause toggles the cyclic job.
 * Double-click a row to edit it.
 */
export function TransmitTable() {
  const { transmitRows, selectedTransmitRowId, setSelectedTransmitRow } = useCanStore(
    useShallow((s) => ({
      transmitRows: s.transmitRows,
      selectedTransmitRowId: s.selectedTransmitRowId,
      setSelectedTransmitRow: s.setSelectedTransmitRow,
    }))
  );
  const nets = useCanStore(useShallow((s) => s.nets));
  const toggleTransmitRowPaused = useCanStore((s) => s.toggleTransmitRowPaused);
  const sendTransmitRowOnce = useCanStore((s) => s.sendTransmitRowOnce);
  const removeTransmitRow = useCanStore((s) => s.removeTransmitRow);

  const [editorState, setEditorState] = useState<{ row: TransmitRow | null } | null>(null);
  const { widths, startResize } = useColumnWidths("transmit-cols", DEFAULT_WIDTHS);

  const netFor = (id: string | null) => nets.find((n) => n.id === id);

  const headers = ["", "Name", "ID", "Net", "DLC", "Data", "Cycle", "Count", "Comment"];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="h-9 px-3 flex items-center justify-between border-b border-can-border bg-can-bg-secondary shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-can-text-secondary">
          Transmit
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xxs text-can-text-muted hidden lg:inline">
            Space = send selected · double-click = edit
          </span>
          <button
            onClick={() => setEditorState({ row: null })}
            className="btn btn-primary h-6 text-xs flex items-center gap-1"
          >
            <PlusIcon className="w-3 h-3" />
            New Message
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="msg-table w-full table-fixed">
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: `${w}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {headers.map((label, i) => (
                <th key={i} className="relative select-none">
                  {label}
                  {i > 0 && i < headers.length - 1 && (
                    <span
                      onPointerDown={(e) => startResize(i, e)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-can-accent-blue/40"
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {transmitRows.length === 0 ? (
              <tr>
                <td colSpan={headers.length} className="text-center py-8 text-can-text-muted text-sm">
                  No transmit messages. Click “New Message” to create one.
                </td>
              </tr>
            ) : (
              transmitRows.map((row) => {
                const net = netFor(row.netId);
                const running = !!row.backendJobId;
                const netConnected = net?.connectionStatus === "connected";
                const selected = selectedTransmitRowId === row.id;
                return (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedTransmitRow(row.id)}
                    onDoubleClick={() => setEditorState({ row })}
                    className={`cursor-default ${selected ? "!bg-can-accent-blue/20" : ""}`}
                  >
                    <td className="text-center">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          running
                            ? "bg-can-accent-green animate-pulse"
                            : row.cycleMs > 0
                              ? "bg-can-accent-amber"
                              : "bg-can-text-muted"
                        }`}
                        title={running ? "Cyclic sending" : row.cycleMs > 0 ? "Cyclic (paused)" : "Manual"}
                      />
                    </td>
                    <td className="truncate font-medium text-can-text-primary">{row.name}</td>
                    <td className={`font-mono ${row.isExtended ? "text-can-accent-purple" : ""}`}>
                      0x
                      {row.canId
                        .toString(16)
                        .toUpperCase()
                        .padStart(row.isExtended ? 8 : 3, "0")}
                    </td>
                    <td className={`truncate ${netConnected ? "text-can-text-secondary" : "text-can-accent-red"}`}>
                      {net?.name ?? "—"}
                    </td>
                    <td className="font-mono">{row.dlc}</td>
                    <td className="font-mono truncate">
                      {row.data
                        .slice(0, row.dlc)
                        .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
                        .join(" ")}
                    </td>
                    <td className="font-mono text-can-text-secondary">
                      {row.cycleMs > 0 ? `${row.cycleMs} ms` : "manual"}
                    </td>
                    <td className="font-mono text-can-text-secondary">{row.count.toLocaleString()}</td>
                    <td className="truncate text-can-text-muted">
                      <span className="flex items-center justify-between gap-1">
                        <span className="truncate">{row.comment}</span>
                        <span className="flex items-center gap-0.5 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              sendTransmitRowOnce(row.id);
                            }}
                            disabled={!netConnected}
                            className="p-1 rounded text-can-text-muted hover:text-can-accent-blue disabled:opacity-30"
                            title="Send once"
                          >
                            <PaperAirplaneIcon className="w-3.5 h-3.5" />
                          </button>
                          {row.cycleMs > 0 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleTransmitRowPaused(row.id);
                              }}
                              disabled={!netConnected && !running}
                              className={`p-1 rounded disabled:opacity-30 ${
                                running
                                  ? "text-can-accent-amber hover:text-can-accent-red"
                                  : "text-can-text-muted hover:text-can-accent-green"
                              }`}
                              title={running ? "Pause cyclic sending" : "Start cyclic sending"}
                            >
                              {running ? (
                                <PauseIcon className="w-3.5 h-3.5" />
                              ) : (
                                <PlayIcon className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditorState({ row });
                            }}
                            className="p-1 rounded text-can-text-muted hover:text-can-text-primary"
                            title="Edit"
                          >
                            <PencilIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeTransmitRow(row.id);
                            }}
                            className="p-1 rounded text-can-text-muted hover:text-can-accent-red"
                            title="Delete"
                          >
                            <TrashIcon className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editorState && (
        <TransmitEditor row={editorState.row} onClose={() => setEditorState(null)} />
      )}
    </div>
  );
}
