import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import { useCanStore } from "../stores/canStore";
import type { InterfaceInfo, Net } from "../types/can";
import { PencilIcon, PlusIcon, TrashIcon, XMarkIcon } from "./icons";

const BITRATES = [
  { value: 1_000_000, label: "1 Mbit/s" },
  { value: 800_000, label: "800 kbit/s" },
  { value: 500_000, label: "500 kbit/s" },
  { value: 250_000, label: "250 kbit/s" },
  { value: 125_000, label: "125 kbit/s" },
  { value: 100_000, label: "100 kbit/s" },
  { value: 83_333, label: "83.3 kbit/s" },
  { value: 50_000, label: "50 kbit/s" },
  { value: 33_333, label: "33.3 kbit/s" },
  { value: 20_000, label: "20 kbit/s" },
  { value: 10_000, label: "10 kbit/s" },
];

/**
 * PCAN-style Nets: named bus definitions (name + bitrate + symbol file) that
 * are bound to auto-detected hardware. Nets persist in the project even when
 * their device is unplugged.
 */
export function NetManager() {
  const nets = useCanStore(useShallow((s) => s.nets));
  const availableInterfaces = useCanStore(useShallow((s) => s.availableInterfaces));
  const activeNetId = useCanStore((s) => s.activeNetId);
  const busStats = useCanStore((s) => s.busStats);
  const addNet = useCanStore((s) => s.addNet);
  const removeNet = useCanStore((s) => s.removeNet);
  const updateNet = useCanStore((s) => s.updateNet);
  const setActiveNet = useCanStore((s) => s.setActiveNet);
  const connectNet = useCanStore((s) => s.connectNet);
  const disconnectNet = useCanStore((s) => s.disconnectNet);
  const loadSymbolFile = useCanStore((s) => s.loadSymbolFile);
  const removeSymbolFile = useCanStore((s) => s.removeSymbolFile);

  const assignedIds = new Set(nets.map((n) => n.assignedDeviceId).filter(Boolean));
  const unassigned = availableInterfaces.filter((i) => !assignedIds.has(i.id));

  return (
    <div className="p-3 space-y-3 border-b border-can-border">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-can-text-secondary">
          Nets
        </h3>
        <button
          onClick={addNet}
          className="btn btn-secondary h-6 text-xs flex items-center gap-1"
          title="Define a new net"
        >
          <PlusIcon className="w-3 h-3" />
          Add
        </button>
      </div>

      {nets.length === 0 && (
        <p className="text-xs text-can-text-muted">
          No nets defined. A net is a named bus (bitrate + symbol file) you
          assign detected hardware to.
        </p>
      )}

      {nets.map((net) => (
        <NetCard
          key={net.id}
          net={net}
          interfaces={availableInterfaces}
          active={activeNetId === net.id}
          busLoad={busStats.get(net.id)?.busLoad ?? 0}
          busState={busStats.get(net.id)?.busState}
          onActivate={() => setActiveNet(net.id)}
          onUpdate={(u) => updateNet(net.id, u)}
          onRemove={() => removeNet(net.id)}
          onConnect={() => connectNet(net.id)}
          onDisconnect={() => disconnectNet(net.id)}
          onLoadSymbols={async () => {
            const filePath = await open({
              title: "Attach Symbol File",
              filters: [
                { name: "Symbol Files", extensions: ["sym", "dbc"] },
                { name: "PCAN Symbol", extensions: ["sym"] },
                { name: "DBC", extensions: ["dbc"] },
              ],
              multiple: false,
            });
            if (filePath && typeof filePath === "string") {
              try {
                await loadSymbolFile(net.id, filePath);
              } catch (e) {
                console.error("Failed to load symbol file:", e);
              }
            }
          }}
          onRemoveSymbols={() => removeSymbolFile(net.id)}
        />
      ))}

      {unassigned.length > 0 && (
        <div className="pt-2 border-t border-can-border/60">
          <h4 className="text-xxs font-semibold uppercase tracking-wider text-can-text-muted mb-1.5">
            Detected hardware
          </h4>
          {unassigned.map((iface) => (
            <div
              key={iface.id}
              className="flex items-center justify-between text-xs py-1 text-can-text-secondary"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    iface.available ? "bg-can-accent-green" : "bg-can-accent-amber"
                  }`}
                  title={iface.condition ?? (iface.available ? "available" : "unavailable")}
                />
                <span className="truncate" title={iface.firmware ? `FW ${iface.firmware}` : undefined}>
                  {iface.name}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface NetCardProps {
  net: Net;
  interfaces: InterfaceInfo[];
  active: boolean;
  busLoad: number;
  busState?: string;
  onActivate: () => void;
  onUpdate: (updates: Partial<Omit<Net, "id" | "connectionStatus">>) => void;
  onRemove: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onLoadSymbols: () => void;
  onRemoveSymbols: () => void;
}

function NetCard({
  net,
  interfaces,
  active,
  busLoad,
  busState,
  onActivate,
  onUpdate,
  onRemove,
  onConnect,
  onDisconnect,
  onLoadSymbols,
  onRemoveSymbols,
}: NetCardProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(net.name);

  const connected = net.connectionStatus === "connected";
  const assignedDevice = interfaces.find((i) => i.id === net.assignedDeviceId);
  const deviceUnplugged = net.assignedDeviceId !== null && !assignedDevice;
  const canConnect =
    !!net.assignedDeviceId && !deviceUnplugged && (assignedDevice?.available || connected);

  const statusColor = connected
    ? busState === "busOff" || busState === "passive"
      ? "bg-can-accent-red"
      : busState === "warning"
        ? "bg-can-accent-amber"
        : "bg-can-accent-green"
    : net.connectionStatus === "error"
      ? "bg-can-accent-red"
      : "bg-can-text-muted";

  return (
    <div
      onClick={onActivate}
      className={`rounded-md border p-2.5 space-y-2 cursor-default transition-colors ${
        active ? "border-can-accent-blue/60 bg-can-bg-tertiary" : "border-can-border bg-can-bg-primary"
      }`}
    >
      {/* Name row */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`} />
          {editingName ? (
            <input
              autoFocus
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                onUpdate({ name: nameDraft.trim() || net.name });
                setEditingName(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setNameDraft(net.name);
                  setEditingName(false);
                }
              }}
              className="input h-6 text-xs w-full"
            />
          ) : (
            <span className="text-sm font-medium text-can-text-primary truncate">{net.name}</span>
          )}
        </span>
        <span className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setNameDraft(net.name);
              setEditingName(true);
            }}
            className="p-1 text-can-text-muted hover:text-can-text-primary"
            title="Rename"
          >
            <PencilIcon className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="p-1 text-can-text-muted hover:text-can-accent-red"
            title="Delete net"
          >
            <TrashIcon className="w-3 h-3" />
          </button>
        </span>
      </div>

      {/* Device + bitrate */}
      <div className="grid grid-cols-2 gap-1.5">
        <select
          value={net.assignedDeviceId ?? ""}
          disabled={connected}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdate({ assignedDeviceId: e.target.value || null })}
          className="select w-full h-7 text-xs"
          title="Assigned device"
        >
          <option value="">No device</option>
          {deviceUnplugged && (
            <option value={net.assignedDeviceId!}>{net.assignedDeviceId} (unplugged)</option>
          )}
          {interfaces.map((iface) => (
            <option
              key={iface.id}
              value={iface.id}
              disabled={!iface.available && iface.id !== net.assignedDeviceId}
            >
              {iface.name}
              {iface.condition === "occupied" ? " (in use)" : ""}
            </option>
          ))}
        </select>
        <select
          value={net.bitrate}
          disabled={connected}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdate({ bitrate: parseInt(e.target.value) })}
          className="select w-full h-7 text-xs"
          title="Bitrate"
        >
          {BITRATES.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </div>

      {deviceUnplugged && (
        <p className="text-xxs text-can-accent-amber">Device unplugged — reconnect it to go online.</p>
      )}

      {/* Symbol file */}
      <div className="flex items-center justify-between gap-2 text-xs">
        {net.symbolFilePath ? (
          <>
            <span
              className="truncate text-can-accent-cyan"
              title={net.symbolFilePath}
            >
              {net.symbolFilePath.split("/").pop()}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveSymbols();
              }}
              className="p-0.5 text-can-text-muted hover:text-can-accent-red shrink-0"
              title="Detach symbol file"
            >
              <XMarkIcon className="w-3 h-3" />
            </button>
          </>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onLoadSymbols();
            }}
            className="text-can-text-muted hover:text-can-accent-blue text-xs"
          >
            + Attach symbol file (.sym / .dbc)
          </button>
        )}
      </div>

      {/* Connect + bus load */}
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            connected ? onDisconnect() : onConnect();
          }}
          disabled={!connected && !canConnect}
          className={`btn flex-1 h-7 text-xs ${connected ? "btn-danger" : "btn-success"} disabled:opacity-40`}
        >
          {net.connectionStatus === "connecting"
            ? "Connecting…"
            : connected
              ? "Disconnect"
              : "Connect"}
        </button>
        {connected && (
          <div className="flex-1" title={`Bus load ${busLoad.toFixed(1)}%`}>
            <div className="h-1.5 bg-can-bg-primary rounded overflow-hidden">
              <div
                className={`h-full transition-all ${
                  busLoad > 80 ? "bg-can-accent-red" : busLoad > 50 ? "bg-can-accent-amber" : "bg-can-accent-green"
                }`}
                style={{ width: `${Math.min(100, busLoad)}%` }}
              />
            </div>
            <span className="text-xxs text-can-text-muted">{busLoad.toFixed(1)}% load</span>
          </div>
        )}
      </div>
    </div>
  );
}
