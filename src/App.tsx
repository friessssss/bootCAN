import { useEffect } from "react";
import { useCanStore } from "./stores/canStore";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { MessageViewer } from "./components/MessageViewer";
import { TransmitPanel } from "./components/TransmitPanel";
import { BusStatus } from "./components/BusStatus";
import { Toolbar } from "./components/Toolbar";

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
        {/* Left Sidebar - Connection & Status */}
        <aside className="w-72 flex flex-col border-r border-can-border bg-can-bg-secondary">
          <ConnectionPanel />
          <BusStatus />
        </aside>

        {/* Center - Message Viewer */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <MessageViewer />
        </main>

        {/* Right Sidebar - Transmit Panel */}
        <aside className="w-80 border-l border-can-border bg-can-bg-secondary">
          <TransmitPanel />
        </aside>
      </div>

      {/* Bottom Status Bar */}
      <StatusBar />
    </div>
  );
}

function StatusBar() {
  const { connectionStatus, traceMessages, busStats } = useCanStore();

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
        <span>Bus Load: {busStats.busLoad.toFixed(1)}%</span>
        <span>TX: {busStats.txCount.toLocaleString()}</span>
        <span>RX: {busStats.rxCount.toLocaleString()}</span>
        <span>Errors: {busStats.errorCount}</span>
      </div>
    </footer>
  );
}

export default App;

