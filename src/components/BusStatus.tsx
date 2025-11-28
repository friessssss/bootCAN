import { useCanStore } from "../stores/canStore";

export function BusStatus() {
  const { busStats, connectionStatus } = useCanStore();
  const isConnected = connectionStatus === "connected";

  return (
    <div className="flex-1 p-4 overflow-auto">
      <h2 className="panel-title mb-4">Bus Status</h2>

      <div className="space-y-4">
        {/* Bus Load Indicator */}
        <div>
          <div className="flex justify-between items-center mb-1.5">
            <span className="label">Bus Load</span>
            <span
              className={`text-sm font-mono ${
                busStats.busLoad > 80
                  ? "text-can-accent-red"
                  : busStats.busLoad > 50
                    ? "text-can-accent-yellow"
                    : "text-can-accent-green"
              }`}
            >
              {busStats.busLoad.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 bg-can-bg-tertiary rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                busStats.busLoad > 80
                  ? "bg-can-accent-red"
                  : busStats.busLoad > 50
                    ? "bg-can-accent-yellow"
                    : "bg-can-accent-green"
              }`}
              style={{ width: `${Math.min(busStats.busLoad, 100)}%` }}
            />
          </div>
        </div>

        {/* Statistics Grid */}
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label="TX Count"
            value={busStats.txCount.toLocaleString()}
            color="text-can-accent-blue"
            enabled={isConnected}
          />
          <StatCard
            label="RX Count"
            value={busStats.rxCount.toLocaleString()}
            color="text-can-accent-green"
            enabled={isConnected}
          />
          <StatCard
            label="TX Errors"
            value={busStats.txErrorCounter.toString()}
            color={
              busStats.txErrorCounter > 0
                ? "text-can-accent-red"
                : "text-can-text-secondary"
            }
            enabled={isConnected}
          />
          <StatCard
            label="RX Errors"
            value={busStats.rxErrorCounter.toString()}
            color={
              busStats.rxErrorCounter > 0
                ? "text-can-accent-red"
                : "text-can-text-secondary"
            }
            enabled={isConnected}
          />
        </div>

        {/* Error Counter */}
        {busStats.errorCount > 0 && (
          <div className="p-3 bg-can-accent-red/10 border border-can-accent-red/30 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm text-can-accent-red font-medium">
                Bus Errors
              </span>
              <span className="text-lg font-mono text-can-accent-red">
                {busStats.errorCount}
              </span>
            </div>
          </div>
        )}

        {/* Connection Status Details */}
        <div className="pt-3 border-t border-can-border-muted">
          <h3 className="label mb-2">Status Details</h3>
          <div className="space-y-1.5 text-sm">
            <StatusRow
              label="State"
              value={
                connectionStatus === "connected"
                  ? "Active"
                  : connectionStatus === "connecting"
                    ? "Connecting"
                    : connectionStatus === "error"
                      ? "Error"
                      : "Idle"
              }
              valueColor={
                connectionStatus === "connected"
                  ? "text-can-accent-green"
                  : connectionStatus === "error"
                    ? "text-can-accent-red"
                    : "text-can-text-muted"
              }
            />
            <StatusRow
              label="Mode"
              value={isConnected ? "Normal" : "-"}
              valueColor="text-can-text-secondary"
            />
            <StatusRow
              label="FD Support"
              value="Classic CAN"
              valueColor="text-can-text-secondary"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  color: string;
  enabled: boolean;
}

function StatCard({ label, value, color, enabled }: StatCardProps) {
  return (
    <div className="p-2.5 bg-can-bg-tertiary rounded-lg">
      <span className="label block mb-1">{label}</span>
      <span
        className={`text-lg font-mono ${enabled ? color : "text-can-text-muted"}`}
      >
        {enabled ? value : "-"}
      </span>
    </div>
  );
}

interface StatusRowProps {
  label: string;
  value: string;
  valueColor: string;
}

function StatusRow({ label, value, valueColor }: StatusRowProps) {
  return (
    <div className="flex justify-between">
      <span className="text-can-text-muted">{label}</span>
      <span className={valueColor}>{value}</span>
    </div>
  );
}

