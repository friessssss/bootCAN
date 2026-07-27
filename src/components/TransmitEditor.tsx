import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { useCanStore } from "../stores/canStore";
import type { DecodedSignal, SignalDef, TransmitRow } from "../types/can";
import { XMarkIcon } from "./icons";

interface MessageDefResponse {
  message: {
    id: number;
    name: string;
    dlc: number;
    signals: SignalDef[];
  };
  valueTables: Record<string, Record<string, string>>;
}

interface TransmitEditorProps {
  /** Row to edit, or null to create a new one. */
  row: TransmitRow | null;
  onClose: () => void;
}

/**
 * Modal transmit-message editor with two synced views:
 * - Signals: pick a symbolic message, type physical values per signal;
 *   the payload bytes are composed via the backend encoder.
 * - Data: raw hex bytes; edits re-decode into the signal values.
 */
export function TransmitEditor({ row, onClose }: TransmitEditorProps) {
  const nets = useCanStore(useShallow((s) => s.nets));
  const messageNames = useCanStore((s) => s.messageNames);
  const addTransmitRow = useCanStore((s) => s.addTransmitRow);
  const updateTransmitRow = useCanStore((s) => s.updateTransmitRow);

  const [tab, setTab] = useState<"signals" | "data">("signals");
  const [name, setName] = useState(row?.name ?? "");
  const [comment, setComment] = useState(row?.comment ?? "");
  const [netId, setNetId] = useState<string | null>(row?.netId ?? nets[0]?.id ?? null);
  const [canIdHex, setCanIdHex] = useState(
    row ? row.canId.toString(16).toUpperCase() : "100"
  );
  const [isExtended, setIsExtended] = useState(row?.isExtended ?? false);
  const [isRemote, setIsRemote] = useState(row?.isRemote ?? false);
  const [dlc, setDlc] = useState(row?.dlc ?? 8);
  const [data, setData] = useState<number[]>(() => {
    const d = row?.data?.slice(0, 8) ?? [];
    return [...d, ...new Array(8 - d.length).fill(0)];
  });
  const [byteInputs, setByteInputs] = useState<string[]>(() =>
    data.map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
  );
  const [cycleMs, setCycleMs] = useState(row?.cycleMs ?? 0);
  const [messageDef, setMessageDef] = useState<MessageDefResponse | null>(null);
  const [signalValues, setSignalValues] = useState<Record<string, number>>(
    row?.signalValues ?? {}
  );
  const [error, setError] = useState<string | null>(null);

  const symbolNames = useMemo(() => {
    if (!netId) return [];
    const map = messageNames.get(netId);
    if (!map) return [];
    return Array.from(map.entries())
      .map(([id, msgName]) => ({ id, name: msgName }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [netId, messageNames]);

  const syncByteInputs = (bytes: number[]) => {
    setByteInputs(bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")));
  };

  /** Re-decode current data into signal values (Data tab -> Signals tab sync). */
  const decodeIntoSignals = useCallback(
    async (bytes: number[], def: MessageDefResponse | null) => {
      if (!def || !netId) return;
      try {
        const decoded = await invoke<DecodedSignal[]>("decode_message", {
          channelId: netId,
          messageId: def.message.id,
          data: bytes.slice(0, dlc),
        });
        const values: Record<string, number> = {};
        for (const d of decoded) values[d.name] = d.physicalValue;
        setSignalValues(values);
      } catch {
        // no decode available
      }
    },
    [netId, dlc]
  );

  /** Load a symbolic message definition and sync everything to it. */
  const selectMessage = async (msgName: string) => {
    if (!netId || !msgName) return;
    try {
      const def = await invoke<MessageDefResponse | null>("get_message_by_name", {
        channelId: netId,
        name: msgName,
      });
      if (!def) return;
      setMessageDef(def);
      setName(def.message.name);
      setCanIdHex(def.message.id.toString(16).toUpperCase());
      setIsExtended(def.message.id > 0x7ff);
      setDlc(def.message.dlc);
      await decodeIntoSignals(data, def);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  // When editing an existing row with symbols loaded, try to resolve its message def
  useEffect(() => {
    if (row && netId) {
      const msgName = messageNames.get(netId)?.get(row.canId);
      if (msgName) selectMessage(msgName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A signal value edit: encode through the backend, update the bytes. */
  const handleSignalChange = async (signalName: string, physical: number) => {
    if (!messageDef || !netId || Number.isNaN(physical)) return;
    const newValues = { ...signalValues, [signalName]: physical };
    setSignalValues(newValues);
    try {
      const bytes = await invoke<number[]>("encode_signals", {
        channelId: netId,
        messageId: messageDef.message.id,
        values: newValues,
        base: data.slice(0, messageDef.message.dlc),
      });
      const padded = [...bytes, ...new Array(Math.max(0, 8 - bytes.length)).fill(0)];
      setData(padded);
      syncByteInputs(padded);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleByteChange = (index: number, value: string) => {
    const next = byteInputs.slice();
    next[index] = value;
    setByteInputs(next);
    const parsed = parseInt(value, 16);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 0xff) {
      const bytes = data.slice();
      bytes[index] = parsed;
      setData(bytes);
      decodeIntoSignals(bytes, messageDef);
    }
  };

  const handleByteBlur = (index: number) => {
    const next = byteInputs.slice();
    next[index] = (data[index] ?? 0).toString(16).toUpperCase().padStart(2, "0");
    setByteInputs(next);
  };

  const handleSave = async () => {
    const canId = parseInt(canIdHex.replace(/^0x/i, ""), 16);
    if (Number.isNaN(canId)) {
      setError("Invalid CAN ID");
      return;
    }
    const maxId = isExtended ? 0x1fffffff : 0x7ff;
    if (canId > maxId) {
      setError(`ID exceeds ${isExtended ? "29-bit" : "11-bit"} range`);
      return;
    }
    const fields = {
      name: name.trim() || `0x${canId.toString(16).toUpperCase()}`,
      comment,
      netId,
      canId,
      isExtended,
      isRemote,
      dlc,
      data: data.slice(0, 8),
      cycleMs: Math.max(0, Math.round(cycleMs)),
      signalValues: messageDef ? signalValues : undefined,
    };
    if (row) {
      await updateTransmitRow(row.id, fields);
    } else {
      addTransmitRow(fields);
    }
    onClose();
  };

  const enumOptionsFor = (sig: SignalDef): Array<{ physical: number; label: string }> | null => {
    if (!sig.value_table || !messageDef) return null;
    const table = messageDef.valueTables[sig.value_table];
    if (!table) return null;
    return Object.entries(table)
      .map(([raw, label]) => ({
        physical: Number(raw) * sig.factor + sig.offset,
        label,
      }))
      .sort((a, b) => a.physical - b.physical);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-can-bg-secondary border border-can-border rounded-lg shadow-2xl w-[640px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="px-4 h-11 flex items-center justify-between border-b border-can-border shrink-0">
          <h2 className="text-sm font-semibold text-can-text-primary">
            {row ? "Edit Transmit Message" : "New Transmit Message"}
          </h2>
          <button onClick={onClose} className="text-can-text-muted hover:text-can-text-primary">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {/* Common fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Message name"
                className="input w-full"
              />
            </div>
            <div>
              <label className="label">Net</label>
              <select
                value={netId ?? ""}
                onChange={(e) => {
                  setNetId(e.target.value || null);
                  setMessageDef(null);
                }}
                className="select w-full"
              >
                {nets.length === 0 && <option value="">No nets defined</option>}
                {nets.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Comment</label>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional comment"
              className="input w-full"
            />
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="label">CAN ID (hex)</label>
              <input
                type="text"
                value={canIdHex}
                onChange={(e) => setCanIdHex(e.target.value)}
                className="input w-full font-mono"
              />
            </div>
            <div>
              <label className="label">DLC</label>
              <input
                type="number"
                min={0}
                max={8}
                value={dlc}
                onChange={(e) =>
                  setDlc(Math.max(0, Math.min(8, parseInt(e.target.value) || 0)))
                }
                className="input w-full"
              />
            </div>
            <div>
              <label className="label">Cycle (ms)</label>
              <input
                type="number"
                min={0}
                step={10}
                value={cycleMs}
                onChange={(e) => setCycleMs(parseInt(e.target.value) || 0)}
                className="input w-full"
                title="0 = manual send only"
              />
            </div>
            <div className="flex items-end gap-3 pb-1.5">
              <label className="flex items-center gap-1.5 text-xs text-can-text-secondary">
                <input
                  type="checkbox"
                  checked={isExtended}
                  onChange={(e) => setIsExtended(e.target.checked)}
                />
                Ext
              </label>
              <label className="flex items-center gap-1.5 text-xs text-can-text-secondary">
                <input
                  type="checkbox"
                  checked={isRemote}
                  onChange={(e) => setIsRemote(e.target.checked)}
                />
                RTR
              </label>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center bg-can-bg-tertiary rounded-md p-0.5 w-fit">
            {(["signals", "data"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 text-xs rounded capitalize transition-colors ${
                  tab === t
                    ? "bg-can-accent-blue text-white"
                    : "text-can-text-secondary hover:text-can-text-primary"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "signals" ? (
            <div className="space-y-3">
              <div>
                <label className="label">Symbolic message</label>
                <select
                  value={messageDef?.message.name ?? ""}
                  onChange={(e) => selectMessage(e.target.value)}
                  className="select w-full"
                  disabled={symbolNames.length === 0}
                >
                  <option value="">
                    {symbolNames.length === 0
                      ? "No symbol file loaded for this net"
                      : "Select a message…"}
                  </option>
                  {symbolNames.map((m) => (
                    <option key={m.id} value={m.name}>
                      {m.name} (0x{m.id.toString(16).toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>

              {messageDef && (
                <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                  {messageDef.message.signals.map((sig) => {
                    const options = enumOptionsFor(sig);
                    const value = signalValues[sig.name] ?? 0;
                    return (
                      <div
                        key={sig.name}
                        className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.7fr)] gap-2 items-center"
                      >
                        <span className="text-xs text-can-accent-cyan truncate" title={sig.comment ?? undefined}>
                          {sig.name}
                        </span>
                        {options ? (
                          <select
                            value={value}
                            onChange={(e) => handleSignalChange(sig.name, Number(e.target.value))}
                            className="select w-full h-7 text-xs"
                          >
                            {!options.some((o) => o.physical === value) && (
                              <option value={value}>{value}</option>
                            )}
                            {options.map((o) => (
                              <option key={o.physical} value={o.physical}>
                                {o.label} ({o.physical})
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="number"
                            value={value}
                            step={sig.factor || 1}
                            onChange={(e) => handleSignalChange(sig.name, parseFloat(e.target.value))}
                            className="input w-full h-7 text-xs font-mono"
                          />
                        )}
                        <span className="text-xxs text-can-text-muted truncate">
                          {sig.unit}
                          {sig.minimum !== null && sig.maximum !== null && sig.minimum < sig.maximum
                            ? ` [${sig.minimum}…${sig.maximum}]`
                            : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Live byte preview */}
              <div className="pt-1 border-t border-can-border">
                <span className="text-xxs uppercase tracking-wider text-can-text-muted">Payload</span>
                <div className="font-mono text-sm text-can-text-primary mt-1">
                  {data.slice(0, dlc).map((b, i) => (
                    <span key={i} className="mr-2">
                      {b.toString(16).toUpperCase().padStart(2, "0")}
                    </span>
                  ))}
                  {dlc === 0 && <span className="text-can-text-muted">(empty)</span>}
                </div>
              </div>
            </div>
          ) : (
            <div>
              <label className="label">Data bytes (hex)</label>
              <div className="grid grid-cols-8 gap-1.5">
                {byteInputs.map((value, i) => (
                  <input
                    key={i}
                    type="text"
                    maxLength={2}
                    value={value}
                    disabled={i >= dlc}
                    onChange={(e) => handleByteChange(i, e.target.value)}
                    onBlur={() => handleByteBlur(i)}
                    onFocus={(e) => e.target.select()}
                    className="input w-full text-center font-mono disabled:opacity-30"
                  />
                ))}
              </div>
              {messageDef && (
                <p className="text-xxs text-can-text-muted mt-2">
                  Byte edits update the signal values on the Signals tab.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-xs text-can-accent-red">{error}</p>}
        </div>

        {/* Footer */}
        <div className="px-4 h-12 flex items-center justify-end gap-2 border-t border-can-border shrink-0">
          <button onClick={onClose} className="btn btn-secondary text-xs">
            Cancel
          </button>
          <button onClick={handleSave} className="btn btn-primary text-xs">
            {row ? "Save Changes" : "Add Message"}
          </button>
        </div>
      </div>
    </div>
  );
}
