import { useCanStore } from "../stores/canStore";

export function BusStatus() {
  const { activeChannel, channelBusStats } = useCanStore();
  const busStats = activeChannel ? channelBusStats.get(activeChannel) : null;
  const busLoad = busStats?.busLoad ?? 0;

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
                busLoad > 80
                  ? "text-can-accent-red"
                  : busLoad > 50
                    ? "text-can-accent-yellow"
                    : "text-can-accent-green"
              }`}
            >
              {busLoad.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 bg-can-bg-tertiary rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                busLoad > 80
                  ? "bg-can-accent-red"
                  : busLoad > 50
                    ? "bg-can-accent-yellow"
                    : "bg-can-accent-green"
              }`}
              style={{ width: `${Math.min(busLoad, 100)}%` }}
            />
          </div>
        </div>

        {!activeChannel && (
          <div className="text-sm text-can-text-muted text-center py-4">
            No active channel selected
          </div>
        )}
      </div>
    </div>
  );
}


