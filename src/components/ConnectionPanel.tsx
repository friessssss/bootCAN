import { useCanStore } from "../stores/canStore";
import { SignalIcon } from "./icons";

const BITRATE_OPTIONS = [
  { value: 125000, label: "125 kbit/s" },
  { value: 250000, label: "250 kbit/s" },
  { value: 500000, label: "500 kbit/s" },
  { value: 1000000, label: "1 Mbit/s" },
];

export function ConnectionPanel() {
  const {
    connectionStatus,
    selectedInterface,
    selectedBitrate,
    availableInterfaces,
    connect,
    disconnect,
    setSelectedInterface,
    setSelectedBitrate,
  } = useCanStore();

  const isConnected = connectionStatus === "connected";
  const isConnecting = connectionStatus === "connecting";

  return (
    <div className="p-4 border-b border-can-border">
      <div className="flex items-center gap-2 mb-4">
        <SignalIcon className="w-5 h-5 text-can-accent-blue" />
        <h2 className="panel-title">Connection</h2>
      </div>

      <div className="space-y-3">
        {/* Interface Selection */}
        <div>
          <label className="label block mb-1.5">Interface</label>
          <select
            className="select w-full"
            value={selectedInterface || ""}
            onChange={(e) => setSelectedInterface(e.target.value)}
            disabled={isConnected || isConnecting}
          >
            <option value="">Select interface...</option>
            {availableInterfaces.map((iface) => (
              <option
                key={iface.id}
                value={iface.id}
                disabled={!iface.available}
              >
                {iface.name} ({iface.type})
              </option>
            ))}
          </select>
        </div>

        {/* Bitrate Selection */}
        <div>
          <label className="label block mb-1.5">Bitrate</label>
          <select
            className="select w-full"
            value={selectedBitrate}
            onChange={(e) => setSelectedBitrate(Number(e.target.value))}
            disabled={isConnected || isConnecting}
          >
            {BITRATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* Connect/Disconnect Button */}
        <button
          className={`btn w-full ${
            isConnected
              ? "btn-danger"
              : isConnecting
                ? "btn-secondary"
                : "btn-success"
          }`}
          onClick={isConnected ? disconnect : connect}
          disabled={!selectedInterface || isConnecting}
        >
          {isConnecting
            ? "Connecting..."
            : isConnected
              ? "Disconnect"
              : "Connect"}
        </button>
      </div>
    </div>
  );
}

