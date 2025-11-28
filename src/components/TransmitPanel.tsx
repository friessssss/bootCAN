import { useState } from "react";
import { useCanStore } from "../stores/canStore";
import {
  PaperAirplaneIcon,
  PlusIcon,
  TrashIcon,
  PlayIcon,
  PauseIcon,
} from "./icons";

export function TransmitPanel() {
  const {
    connectionStatus,
    pendingTransmit,
    setPendingTransmit,
    sendMessage,
    transmitJobs,
    addTransmitJob,
    removeTransmitJob,
    toggleTransmitJob,
  } = useCanStore();

  const [intervalMs, setIntervalMs] = useState(100);
  const isConnected = connectionStatus === "connected";

  const handleIdChange = (value: string) => {
    const parsed = parseInt(value.replace("0x", ""), 16);
    if (!isNaN(parsed)) {
      setPendingTransmit({ id: parsed });
    }
  };

  const handleDlcChange = (value: number) => {
    const dlc = Math.max(0, Math.min(8, value));
    setPendingTransmit({ dlc });
  };

  const handleDataChange = (index: number, value: string) => {
    const parsed = parseInt(value.replace("0x", ""), 16);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 255) {
      const newData = [...(pendingTransmit.data || [])];
      newData[index] = parsed;
      setPendingTransmit({ data: newData });
    }
  };

  const handleSend = () => {
    if (!isConnected) return;
    sendMessage({
      id: pendingTransmit.id,
      isExtended: pendingTransmit.isExtended,
      isRemote: pendingTransmit.isRemote,
      dlc: pendingTransmit.dlc,
      data: pendingTransmit.data,
    });
  };

  const handleAddPeriodic = () => {
    addTransmitJob({
      frame: {
        id: pendingTransmit.id || 0x100,
        isExtended: pendingTransmit.isExtended || false,
        isRemote: pendingTransmit.isRemote || false,
        dlc: pendingTransmit.dlc || 8,
        data: pendingTransmit.data || [0, 0, 0, 0, 0, 0, 0, 0],
        timestamp: 0,
        channel: "",
        direction: "tx",
      },
      intervalMs,
      enabled: false,
    });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-can-border">
        <h2 className="panel-title mb-4">Transmit</h2>

        {/* Message Editor */}
        <div className="space-y-3">
          {/* ID & Flags */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="label block mb-1.5">ID (Hex)</label>
              <input
                type="text"
                className="input w-full font-mono"
                value={`0x${(pendingTransmit.id || 0).toString(16).toUpperCase()}`}
                onChange={(e) => handleIdChange(e.target.value)}
                disabled={!isConnected}
              />
            </div>
            <div className="w-16">
              <label className="label block mb-1.5">DLC</label>
              <input
                type="number"
                className="input w-full font-mono text-center"
                value={pendingTransmit.dlc || 8}
                onChange={(e) => handleDlcChange(Number(e.target.value))}
                min={0}
                max={8}
                disabled={!isConnected}
              />
            </div>
          </div>

          {/* Flags */}
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="rounded border-can-border bg-can-bg-tertiary"
                checked={pendingTransmit.isExtended || false}
                onChange={(e) =>
                  setPendingTransmit({ isExtended: e.target.checked })
                }
                disabled={!isConnected}
              />
              <span className="text-can-text-secondary">Extended ID</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="rounded border-can-border bg-can-bg-tertiary"
                checked={pendingTransmit.isRemote || false}
                onChange={(e) =>
                  setPendingTransmit({ isRemote: e.target.checked })
                }
                disabled={!isConnected}
              />
              <span className="text-can-text-secondary">Remote Frame</span>
            </label>
          </div>

          {/* Data Bytes */}
          <div>
            <label className="label block mb-1.5">Data (Hex)</label>
            <div className="grid grid-cols-8 gap-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <input
                  key={i}
                  type="text"
                  className={`input font-mono text-center text-xs px-1 ${
                    i >= (pendingTransmit.dlc || 8)
                      ? "opacity-30"
                      : ""
                  }`}
                  value={(pendingTransmit.data?.[i] || 0)
                    .toString(16)
                    .toUpperCase()
                    .padStart(2, "0")}
                  onChange={(e) => handleDataChange(i, e.target.value)}
                  maxLength={2}
                  disabled={!isConnected || i >= (pendingTransmit.dlc || 8)}
                />
              ))}
            </div>
          </div>

          {/* Send Button */}
          <button
            className="btn btn-primary w-full flex items-center justify-center gap-2"
            onClick={handleSend}
            disabled={!isConnected}
          >
            <PaperAirplaneIcon className="w-4 h-4" />
            Send Message
          </button>
        </div>
      </div>

      {/* Periodic Transmit */}
      <div className="flex-1 p-4 overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-can-text-primary">
            Periodic Transmit
          </h3>
          <div className="flex items-center gap-2">
            <input
              type="number"
              className="input w-20 text-xs font-mono"
              value={intervalMs}
              onChange={(e) => setIntervalMs(Number(e.target.value))}
              min={10}
              step={10}
            />
            <span className="text-xs text-can-text-muted">ms</span>
            <button
              className="btn btn-secondary p-1.5"
              onClick={handleAddPeriodic}
              disabled={!isConnected}
              title="Add periodic job"
            >
              <PlusIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Periodic Jobs List */}
        <div className="space-y-2">
          {transmitJobs.length === 0 ? (
            <p className="text-sm text-can-text-muted text-center py-4">
              No periodic jobs configured
            </p>
          ) : (
            transmitJobs.map((job) => (
              <div
                key={job.id}
                className="p-2 bg-can-bg-tertiary rounded-lg flex items-center justify-between"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">
                      0x
                      {job.frame.id
                        .toString(16)
                        .toUpperCase()
                        .padStart(3, "0")}
                    </span>
                    <span className="text-xs text-can-text-muted">
                      @ {job.intervalMs}ms
                    </span>
                  </div>
                  <div className="text-xs font-mono text-can-text-secondary truncate">
                    {job.frame.data
                      .slice(0, job.frame.dlc)
                      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
                      .join(" ")}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    className={`btn p-1.5 ${
                      job.enabled ? "btn-success" : "btn-secondary"
                    }`}
                    onClick={() => toggleTransmitJob(job.id)}
                    disabled={!isConnected}
                  >
                    {job.enabled ? (
                      <PauseIcon className="w-3.5 h-3.5" />
                    ) : (
                      <PlayIcon className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    className="btn btn-secondary p-1.5"
                    onClick={() => removeTransmitJob(job.id)}
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

