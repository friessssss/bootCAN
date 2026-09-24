import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCanStore } from "./stores/canStore";
import { MonitorWindow } from "./components/MonitorWindow";
import { PlotPanel } from "./components/PlotPanel";
import { Toolbar } from "./components/Toolbar";
import { NetManager } from "./components/NetManager";
import { FilterPanel } from "./components/FilterPanel";

function App() {
  const initializeBackend = useCanStore((s) => s.initializeBackend);
  const viewTab = useCanStore((s) => s.viewTab);

  useEffect(() => {
    initializeBackend();
  }, [initializeBackend]);

  return (
    <div className="h-screen flex flex-col bg-can-bg-primary">
      <Toolbar />

      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar: Nets & filters (Monitor tab only) */}
        {viewTab === "monitor" && (
          <aside className="w-72 flex flex-col border-r border-can-border bg-can-bg-secondary overflow-y-auto shrink-0">
            <NetManager />
            <FilterPanel />
          </aside>
        )}

        {/* Center: combined receive/transmit window or plot */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {viewTab === "monitor" ? <MonitorWindow /> : <PlotPanel />}
        </main>
      </div>

      <StatusBar />
    </div>
  );
}

function StatusBar() {
  const nets = useCanStore(useShallow((s) => s.nets));
  const busStats = useCanStore((s) => s.busStats);
  const monitorCount = useCanStore((s) => s.monitorMessages.size);
  const traceCount = useCanStore((s) => s.traceFrameCount);
  const visibleTrace = useCanStore((s) => s.traceMessages.length);
  const isRecording = useCanStore((s) => s.isRecording);
  const traceTruncated = useCanStore((s) => s.traceTruncated);
  const traceNotice = useCanStore((s) => s.traceNotice);
  const isPaused = useCanStore((s) => s.isPaused);

  const busStateLabel = (state?: string) => {
    switch (state) {
      case "warning":
        return " · warning";
      case "passive":
        return " · error passive";
      case "busOff":
        return " · BUS OFF";
      default:
        return "";
    }
  };

  return (
    <footer className="h-6 px-4 flex items-center justify-between bg-can-bg-tertiary border-t border-can-border text-xs text-can-text-secondary">
      <div className="flex items-center gap-4 min-w-0">
        {nets.length === 0 ? (
          <span className="text-can-text-muted">No nets defined</span>
        ) : (
          nets.map((net) => {
            const stats = busStats.get(net.id);
            const connected = net.connectionStatus === "connected";
            const bad = stats?.busState === "busOff" || stats?.busState === "passive";
            return (
              <span key={net.id} className="flex items-center gap-1.5 min-w-0">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    connected
                      ? bad
                        ? "bg-can-accent-red"
                        : stats?.busState === "warning"
                          ? "bg-can-accent-amber"
                          : "bg-can-accent-green"
                      : net.connectionStatus === "error"
                        ? "bg-can-accent-red"
                        : "bg-can-text-muted"
                  }`}
                />
                <span className="truncate">
                  {net.name}
                  {connected && stats
                    ? `: ${stats.busLoad.toFixed(1)}%${busStateLabel(stats.busState)}`
                    : net.connectionStatus === "error"
                      ? ": error"
                      : ""}
                </span>
              </span>
            );
          })
        )}
      </div>
      <div className="flex items-center gap-4 shrink-0">
        {isPaused && <span className="text-can-accent-amber">PAUSED</span>}
        {traceNotice && (
          <span className="text-can-text-muted truncate max-w-64" title={traceNotice}>
            {traceNotice}
          </span>
        )}
        <span>IDs: {monitorCount.toLocaleString()}</span>
        <span className={isRecording ? "text-can-accent-red" : undefined}>
          {isRecording ? "● " : ""}
          Trace: {(traceCount > 0 ? traceCount : visibleTrace).toLocaleString()}
          {traceTruncated ? " (full)" : ""}
        </span>
      </div>
    </footer>
  );
}

export default App;
