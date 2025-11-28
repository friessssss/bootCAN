import { useState } from "react";
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

export function FilterPanel() {
  const { activeChannel, filters, setFilters } = useCanStore();
  const [logic, setLogic] = useState<"and" | "or">("and");

  const addFilter = () => {
    const newFilter: FilterRule = {
      type: "idRange",
      idMin: 0,
      idMax: 0x7FF,
    };
    setFilters([...filters, newFilter]);
  };

  const removeFilter = (index: number) => {
    setFilters(filters.filter((_, i) => i !== index));
  };

  const updateFilter = (index: number, updates: Partial<FilterRule>) => {
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index], ...updates };
    setFilters(newFilters);
  };

  const applyFilters = async () => {
    if (!activeChannel) return;

    try {
      // Convert frontend filters to backend format
      const backendFilters: any[] = filters.map((f) => {
        switch (f.type) {
          case "idRange":
            return {
              IdRange: { min: f.idMin || 0, max: f.idMax || 0x7FF },
            };
          case "idExact":
            return { IdExact: f.idExact || 0 };
          case "dlcRange":
            return {
              DlcRange: { min: f.dlcMin || 0, max: f.dlcMax || 8 },
            };
          case "direction":
            return { Direction: { rx: f.rx || false, tx: f.tx || false } };
          case "extendedId":
            return { ExtendedId: f.extended || false };
          case "remoteFrame":
            return { RemoteFrame: f.remote || false };
          default:
            return null;
        }
      }).filter((f) => f !== null);

      await invoke("set_advanced_filter", {
        channelId: activeChannel,
        filter: {
          rules: backendFilters,
          logic: logic === "and" ? "And" : "Or",
        },
      });
    } catch (error) {
      console.error("Failed to apply filters:", error);
    }
  };

  return (
    <div className="p-2 space-y-1.5 border-b border-can-border overflow-y-auto flex-shrink-0" style={{ maxHeight: "40vh", minHeight: "150px" }}>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-semibold text-can-text-primary">Filters</h3>
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

          <div className="space-y-1 max-h-[calc(40vh-100px)] overflow-y-auto">
            {filters.map((filter, index) => (
              <div
                key={index}
                className="bg-can-bg-tertiary rounded px-1.5 py-1 space-y-1"
              >
              <div className="flex items-center justify-between gap-1">
                <select
                  value={filter.type}
                  onChange={(e) =>
                    updateFilter(index, {
                      type: e.target.value as FilterRule["type"],
                    })
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
                >
                  <XMarkIcon className="w-3 h-3" />
                </button>
              </div>

              {filter.type === "idRange" && (
                <div className="flex gap-1 text-xxs">
                  <input
                    type="number"
                    placeholder="Min"
                    value={filter.idMin || ""}
                    onChange={(e) =>
                      updateFilter(index, {
                        idMin: parseInt(e.target.value) || 0,
                      })
                    }
                    className="input flex-1 px-1 py-0.5 text-xxs"
                  />
                  <input
                    type="number"
                    placeholder="Max"
                    value={filter.idMax || ""}
                    onChange={(e) =>
                      updateFilter(index, {
                        idMax: parseInt(e.target.value) || 0x7FF,
                      })
                    }
                    className="input flex-1 px-1 py-0.5 text-xxs"
                  />
                </div>
              )}

              {filter.type === "idExact" && (
                <input
                  type="number"
                  placeholder="ID"
                  value={filter.idExact || ""}
                  onChange={(e) =>
                    updateFilter(index, {
                      idExact: parseInt(e.target.value) || 0,
                    })
                  }
                  className="input text-xxs w-full px-1 py-0.5"
                />
              )}

              {filter.type === "dlcRange" && (
                <div className="flex gap-1 text-xxs">
                  <input
                    type="number"
                    placeholder="Min"
                    min="0"
                    max="8"
                    value={filter.dlcMin || ""}
                    onChange={(e) =>
                      updateFilter(index, {
                        dlcMin: parseInt(e.target.value) || 0,
                      })
                    }
                    className="input flex-1 px-1 py-0.5 text-xxs"
                  />
                  <input
                    type="number"
                    placeholder="Max"
                    min="0"
                    max="8"
                    value={filter.dlcMax || ""}
                    onChange={(e) =>
                      updateFilter(index, {
                        dlcMax: parseInt(e.target.value) || 8,
                      })
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
                      onChange={(e) =>
                        updateFilter(index, { rx: e.target.checked })
                      }
                      className="w-3 h-3"
                    />
                    RX
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={filter.tx || false}
                      onChange={(e) =>
                        updateFilter(index, { tx: e.target.checked })
                      }
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
                    onChange={(e) =>
                      updateFilter(index, { extended: e.target.checked })
                    }
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
                    onChange={(e) =>
                      updateFilter(index, { remote: e.target.checked })
                    }
                    className="w-3 h-3"
                  />
                  Remote Frame
                </label>
              )}
              </div>
            ))}
          </div>

          <button
            onClick={applyFilters}
            className="btn btn-primary w-full text-xxs px-1.5 py-0.5 mt-1"
            disabled={!activeChannel}
          >
            Apply Filters
          </button>
        </div>
      )}

      {filters.length === 0 && (
        <div className="text-xxs text-can-text-muted text-center py-1">
          No filters. Add a filter to start filtering messages.
        </div>
      )}
    </div>
  );
}

