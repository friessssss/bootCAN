import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCanStore } from "../stores/canStore";
import { invoke } from "@tauri-apps/api/core";
import { PlusIcon, XMarkIcon } from "./icons";

interface FilterRule {
  type: "idRange" | "idExact" | "dlcRange" | "direction" | "extendedId" | "remoteFrame";
  idMin?: number;
  idMax?: number;
  idExact?: number;
  dlcMin?: number;
  dlcMax?: number;
  rx?: boolean;
  tx?: boolean;
  extended?: boolean;
  remote?: boolean;
}

/** Hex ID input: shows 0x…, accepts hex with or without prefix. */
function HexInput({
  value,
  onCommit,
  placeholder,
}: {
  value: number;
  onCommit: (v: number) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(`0x${value.toString(16).toUpperCase()}`);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(`0x${value.toString(16).toUpperCase()}`);
  }, [value, focused]);

  const parse = (s: string): number | null => {
    const t = s.trim().replace(/^0x/i, "");
    if (!t || !/^[0-9a-fA-F]+$/.test(t)) return null;
    const n = parseInt(t, 16);
    return Number.isNaN(n) ? null : n;
  };

  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const n = parse(text);
        if (n !== null) onCommit(n);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value);
        if (n !== null) onCommit(n);
      }}
      className="input flex-1 px-1 py-0.5 text-xxs font-mono min-w-0"
    />
  );
}

export function FilterPanel() {
  const filters = useCanStore((s) => s.filters);
  const setFilters = useCanStore((s) => s.setFilters);
  const nets = useCanStore(useShallow((s) => s.nets));
  const [logic, setLogic] = useState<"and" | "or">("and");

  // Reapply when a net (re)connects, not just when rules change
  const netKey = nets.map((n) => `${n.id}:${n.connectionStatus}`).join(",");

  // The receive list is only reset when the RULES change — never on net
  // connect/disconnect (disconnecting must not clear received messages).
  const rulesKey = JSON.stringify({ filters, logic });
  const prevRulesKey = useRef(rulesKey);
  const pendingReset = useRef(false);

  // Auto-apply: debounce rule edits, push to every net, and reset the
  // aggregated receive list so the effect of the filter is visible immediately.
  useEffect(() => {
    if (prevRulesKey.current !== rulesKey) {
      prevRulesKey.current = rulesKey;
      pendingReset.current = true;
    }

    const timer = setTimeout(() => {
      const backendFilters: any[] = filters
        .map((f) => {
          switch (f.type) {
            case "idRange":
              return { IdRange: { min: f.idMin || 0, max: f.idMax ?? 0x7ff } };
            case "idExact":
              return { IdExact: f.idExact || 0 };
            case "dlcRange":
              return { DlcRange: { min: f.dlcMin || 0, max: f.dlcMax ?? 8 } };
            case "direction":
              return { Direction: { rx: f.rx || false, tx: f.tx || false } };
            case "extendedId":
              return { ExtendedId: f.extended || false };
            case "remoteFrame":
              return { RemoteFrame: f.remote || false };
            default:
              return null;
          }
        })
        .filter((f) => f !== null);

      for (const net of nets) {
        invoke("set_advanced_filter", {
          channelId: net.id,
          filter: {
            rules: backendFilters,
            logic: logic === "and" ? "And" : "Or",
          },
        }).catch(() => {
          // Net not registered in the backend yet (never connected) — fine
        });
      }

      if (pendingReset.current) {
        pendingReset.current = false;
        useCanStore.setState({
          monitorMessages: new Map(),
          expandedRows: new Set(),
        });
      }
    }, 300);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey, netKey]);

  const addFilter = () => {
    setFilters([...filters, { type: "idRange", idMin: 0, idMax: 0x7ff }]);
  };

  const removeFilter = (index: number) => {
    setFilters(filters.filter((_, i) => i !== index));
  };

  const updateFilter = (index: number, updates: Partial<FilterRule>) => {
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index], ...updates };
    setFilters(newFilters);
  };

  return (
    <div
      className="p-2 space-y-1.5 border-b border-can-border overflow-y-auto flex-shrink-0"
      style={{ maxHeight: "40vh", minHeight: "120px" }}
    >
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-can-text-secondary">
          Filters
        </h3>
        <button onClick={addFilter} className="btn btn-secondary text-xxs px-1.5 py-0.5">
          <PlusIcon className="w-3 h-3" />
          Add
        </button>
      </div>

      {filters.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1 mb-0.5">
            <span className="text-xxs text-can-text-secondary">Logic:</span>
            <select
              value={logic}
              onChange={(e) => setLogic(e.target.value as "and" | "or")}
              className="input text-xxs px-1 py-0.5 flex-1"
            >
              <option value="and">AND</option>
              <option value="or">OR</option>
            </select>
          </div>

          <div className="space-y-1">
            {filters.map((filter, index) => (
              <div key={index} className="bg-can-bg-tertiary rounded px-1.5 py-1 space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <select
                    value={filter.type}
                    onChange={(e) =>
                      updateFilter(index, { type: e.target.value as FilterRule["type"] })
                    }
                    className="input text-xxs px-1 py-0.5 flex-1"
                  >
                    <option value="idRange">ID Range</option>
                    <option value="idExact">ID Exact</option>
                    <option value="dlcRange">DLC Range</option>
                    <option value="direction">Direction</option>
                    <option value="extendedId">Extended ID</option>
                    <option value="remoteFrame">Remote Frame</option>
                  </select>
                  <button
                    onClick={() => removeFilter(index)}
                    className="ml-2 text-can-text-muted hover:text-can-accent-red"
                    title="Remove filter"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </div>

                {filter.type === "idRange" && (
                  <div className="flex gap-1 text-xxs">
                    <HexInput
                      value={filter.idMin ?? 0}
                      onCommit={(v) => updateFilter(index, { idMin: v })}
                      placeholder="0x000"
                    />
                    <HexInput
                      value={filter.idMax ?? 0x7ff}
                      onCommit={(v) => updateFilter(index, { idMax: v })}
                      placeholder="0x7FF"
                    />
                  </div>
                )}

                {filter.type === "idExact" && (
                  <div className="flex text-xxs">
                    <HexInput
                      value={filter.idExact ?? 0}
                      onCommit={(v) => updateFilter(index, { idExact: v })}
                      placeholder="0x123"
                    />
                  </div>
                )}

                {filter.type === "dlcRange" && (
                  <div className="flex gap-1 text-xxs">
                    <input
                      type="number"
                      placeholder="Min"
                      min="0"
                      max="8"
                      value={filter.dlcMin ?? ""}
                      onChange={(e) =>
                        updateFilter(index, { dlcMin: parseInt(e.target.value) || 0 })
                      }
                      className="input flex-1 px-1 py-0.5 text-xxs"
                    />
                    <input
                      type="number"
                      placeholder="Max"
                      min="0"
                      max="8"
                      value={filter.dlcMax ?? ""}
                      onChange={(e) =>
                        updateFilter(index, { dlcMax: parseInt(e.target.value) || 8 })
                      }
                      className="input flex-1 px-1 py-0.5 text-xxs"
                    />
                  </div>
                )}

                {filter.type === "direction" && (
                  <div className="flex gap-2 text-xxs">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={filter.rx || false}
                        onChange={(e) => updateFilter(index, { rx: e.target.checked })}
                        className="w-3 h-3"
                      />
                      RX
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={filter.tx || false}
                        onChange={(e) => updateFilter(index, { tx: e.target.checked })}
                        className="w-3 h-3"
                      />
                      TX
                    </label>
                  </div>
                )}

                {filter.type === "extendedId" && (
                  <label className="flex items-center gap-1 text-xxs">
                    <input
                      type="checkbox"
                      checked={filter.extended || false}
                      onChange={(e) => updateFilter(index, { extended: e.target.checked })}
                      className="w-3 h-3"
                    />
                    Extended ID
                  </label>
                )}

                {filter.type === "remoteFrame" && (
                  <label className="flex items-center gap-1 text-xxs">
                    <input
                      type="checkbox"
                      checked={filter.remote || false}
                      onChange={(e) => updateFilter(index, { remote: e.target.checked })}
                      className="w-3 h-3"
                    />
                    Remote Frame
                  </label>
                )}
              </div>
            ))}
          </div>

          <p className="text-xxs text-can-text-muted pt-0.5">
            Filters apply automatically to all nets.
          </p>
        </div>
      )}

      {filters.length === 0 && (
        <div className="text-xxs text-can-text-muted text-center py-1">
          No filters — all messages pass.
        </div>
      )}
    </div>
  );
}
