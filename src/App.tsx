import { useEffect } from "react";
import { useCanStore } from "./stores/canStore";
import { MessageViewer } from "./components/MessageViewer";
import { TransmitPanel } from "./components/TransmitPanel";
import { Toolbar } from "./components/Toolbar";
import { TraceManager } from "./components/TraceManager";
import { SignalInspector } from "./components/SignalInspector";
import { ChannelManager } from "./components/ChannelManager";
import { FilterPanel } from "./components/FilterPanel";

function App() {
  const { initializeBackend } = useCanStore();

  useEffect(() => {
    initializeBackend();
  }, [initializeBackend]);

  return (
    <div className="h-screen flex flex-col bg-can-bg-primary">
      {/* Top Toolbar */}
      <Toolbar />

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Channels & Status */}
        <aside className="w-72 flex flex-col border-r border-can-border bg-can-bg-secondary overflow-y-auto">
          <ChannelManager />
          <FilterPanel />
        </aside>

        {/* Center - Message Viewer */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <MessageViewer />
        </main>

        {/* Right Sidebar - Transmit Panel & Signal Inspector */}
        <aside className="w-80 border-l border-can-border bg-can-bg-secondary flex flex-col overflow-hidden">
          <TransmitPanel />
          <div className="border-t border-can-border overflow-y-auto">
            <SignalInspector />
          </div>
        </aside>
      </div>

      {/* Bottom Status Bar */}
      <StatusBar />
    </div>
  );
}

function StatusBar() {
  const { connectionStatus, traceMessages, activeChannel, channelBusStats } = useCanStore();
  const busStats = activeChannel ? channelBusStats.get(activeChannel) : null;
  const busLoad = busStats?.busLoad ?? 0;

  return (
    <footer className="h-6 px-4 flex items-center justify-between bg-can-bg-tertiary border-t border-can-border text-xs text-can-text-secondary">
      <div className="flex items-center gap-4">
        <span
          className={`flex items-center gap-1.5 ${
            connectionStatus === "connected"
              ? "text-can-accent-green"
              : connectionStatus === "error"
                ? "text-can-accent-red"
                : "text-can-text-muted"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              connectionStatus === "connected"
                ? "bg-can-accent-green"
                : connectionStatus === "error"
                  ? "bg-can-accent-red"
                  : "bg-can-text-muted"
            }`}
          />
          {connectionStatus === "connected"
            ? "Connected"
            : connectionStatus === "connecting"
              ? "Connecting..."
              : connectionStatus === "error"
                ? "Error"
                : "Disconnected"}
        </span>
        <span>Messages: {traceMessages.length.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-4">
        {activeChannel && <span>Bus Load: {busLoad.toFixed(1)}%</span>}
      </div>
    </footer>
  );
}

export default App;

