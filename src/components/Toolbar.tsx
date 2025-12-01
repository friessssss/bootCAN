import { useCanStore } from "../stores/canStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  PlayIcon,
  PauseIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  RecordIcon,
  StopIcon,
} from "./icons";

export function Toolbar() {
  const { isPaused, togglePause, clearMessages, traceMessages, connectionStatus, viewMode, setViewMode, isRecording, toggleRecording, saveProject, loadProject, viewTab, setViewTab } =
    useCanStore();

  const handleExport = () => {
    if (traceMessages.length === 0) return;

    // Create CSV content - export format: Time, ID, DLC, Data, Direction, Channel
    const headers = ["Time", "ID", "DLC", "Data", "Direction", "Channel"];
    const rows = traceMessages.map((msg) => [
      msg.timestamp.toFixed(6),
      `0x${msg.id.toString(16).toUpperCase().padStart(msg.isExtended ? 8 : 3, "0")}`,
      msg.dlc,
      msg.data
        .slice(0, msg.dlc)
        .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
        .join(" "),
      msg.direction.toUpperCase(),
      msg.channel,
    ]);

    const csv = [headers, ...rows].map((row) => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `can_trace_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveProject = async () => {
    try {
      const filePath = await save({
        title: "Save Project",
        filters: [
          { name: "bootCAN Project", extensions: ["bootcan", "json"] },
          { name: "JSON Files", extensions: ["json"] },
        ],
        defaultPath: "project.bootcan",
      });

      if (filePath && typeof filePath === "string") {
        await saveProject(filePath);
      }
    } catch (error) {
      console.error("Failed to save project:", error);
    }
  };

  const handleLoadProject = async () => {
    try {
      const filePath = await open({
        title: "Load Project",
        filters: [
          { name: "bootCAN Project", extensions: ["bootcan", "json"] },
          { name: "JSON Files", extensions: ["json"] },
        ],
        multiple: false,
      });

      if (filePath && typeof filePath === "string") {
        await loadProject(filePath);
      }
    } catch (error) {
      console.error("Failed to load project:", error);
    }
  };

  return (
    <header className="h-12 px-4 flex items-center justify-between bg-can-bg-secondary border-b border-can-border">
      {/* Left - Logo & Title */}
      <div className="flex items-center gap-3">
        <img src="/can-icon.svg" alt="CAN" className="w-7 h-7" />
        <h1 className="text-lg font-semibold text-can-text-primary">
          bootCAN
        </h1>
      </div>

      {/* Center - View Tabs & Main Controls */}
      <div className="flex items-center gap-4">
        {/* View Tab Toggle */}
        <div className="flex items-center bg-can-bg-tertiary rounded-md p-0.5">
          <button
            onClick={() => setViewTab("monitor")}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              viewTab === "monitor"
                ? "bg-can-accent-blue text-white"
                : "text-can-text-secondary hover:text-can-text-primary"
            }`}
          >
            Monitor
          </button>
          <button
            onClick={() => setViewTab("plot")}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              viewTab === "plot"
                ? "bg-can-accent-blue text-white"
                : "text-can-text-secondary hover:text-can-text-primary"
            }`}
          >
            Plot
          </button>
        </div>

        <div className="w-px h-6 bg-can-border" />

        {/* Main Controls */}
        <div className="flex items-center gap-2">
        <button
          onClick={togglePause}
          className={`btn ${isPaused ? "btn-success" : "btn-secondary"} flex items-center gap-2`}
          disabled={connectionStatus !== "connected"}
        >
          {isPaused ? (
            <>
              <PlayIcon className="w-4 h-4" />
              Resume
            </>
          ) : (
            <>
              <PauseIcon className="w-4 h-4" />
              Pause
            </>
          )}
        </button>

        <button
          onClick={clearMessages}
          className="btn btn-secondary flex items-center gap-2"
        >
          <TrashIcon className="w-4 h-4" />
          Clear
        </button>

        <div className="w-px h-6 bg-can-border mx-2" />

          {/* View Mode Toggle - only visible in Monitor tab */}
          {viewTab === "monitor" && (
            <>
              <div className="flex items-center bg-can-bg-tertiary rounded-md p-0.5">
                <button
                  onClick={() => setViewMode("monitor")}
                  className={`px-3 py-1 text-sm rounded transition-colors ${
                    viewMode === "monitor"
                      ? "bg-can-accent-blue text-white"
                      : "text-can-text-secondary hover:text-can-text-primary"
                  }`}
                >
                  Monitor
                </button>
                <button
                  onClick={() => setViewMode("trace")}
                  className={`px-3 py-1 text-sm rounded transition-colors ${
                    viewMode === "trace"
                      ? "bg-can-accent-blue text-white"
                      : "text-can-text-secondary hover:text-can-text-primary"
                  }`}
                >
                  Trace
                </button>
              </div>

              {/* Record Trace Button - only visible in trace mode */}
              {viewMode === "trace" && (
                <>
                  <div className="w-px h-6 bg-can-border mx-2" />
                  <button
                    onClick={toggleRecording}
                    className={`btn flex items-center gap-2 ${
                      isRecording ? "btn-danger" : "btn-success"
                    }`}
                    disabled={connectionStatus !== "connected"}
                  >
                    {isRecording ? (
                      <>
                        <StopIcon className="w-4 h-4" />
                        Stop Recording
                      </>
                    ) : (
                      <>
                        <RecordIcon className="w-4 h-4" />
                        Record Trace
                      </>
                    )}
                  </button>
                </>
              )}

              {/* Export and Project buttons - only visible in Monitor tab */}
              <div className="w-px h-6 bg-can-border mx-2" />

              <button
                onClick={handleExport}
                className="btn btn-secondary flex items-center gap-2"
                disabled={traceMessages.length === 0}
              >
                <ArrowDownTrayIcon className="w-4 h-4" />
                Export CSV
              </button>

              <div className="w-px h-6 bg-can-border mx-2" />

              <button
                onClick={handleSaveProject}
                className="btn btn-secondary flex items-center gap-2"
              >
                <ArrowDownTrayIcon className="w-4 h-4" />
                Save Project
              </button>

              <button
                onClick={handleLoadProject}
                className="btn btn-secondary flex items-center gap-2"
              >
                <ArrowDownTrayIcon className="w-4 h-4" />
                Load Project
              </button>
            </>
          )}
        </div>
      </div>

      {/* Right - Version */}
          <div className="text-xs text-can-text-muted">v0.2.0</div>
    </header>
  );
}

