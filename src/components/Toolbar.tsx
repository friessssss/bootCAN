import { useCanStore, useAnyConnected } from "../stores/canStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  PlayIcon,
  PauseIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  RecordIcon,
  StopIcon,
  FolderOpenIcon,
} from "./icons";

export function Toolbar() {
  const { isPaused, togglePause, clearMessages, traceMessages, viewMode, setViewMode, isRecording, toggleRecording, saveProject, loadProject, viewTab, setViewTab } =
    useCanStore();
  const anyConnected = useAnyConnected();

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

  const tabButton = (active: boolean) =>
    `px-3 py-1 text-sm rounded transition-colors ${
      active
        ? "bg-can-accent-blue text-white"
        : "text-can-text-secondary hover:text-can-text-primary"
    }`;

  return (
    <header className="h-12 px-3 flex items-center gap-3 bg-can-bg-secondary border-b border-can-border overflow-hidden">
      {/* Left - Logo & Title */}
      <div className="flex items-center gap-2 shrink-0">
        <img src="/can-icon.svg" alt="CAN" className="w-7 h-7" />
        <h1 className="text-lg font-semibold text-can-text-primary hidden lg:block">bootCAN</h1>
      </div>

      <div className="w-px h-6 bg-can-border shrink-0" />

      {/* View Tab Toggle */}
      <div className="flex items-center bg-can-bg-tertiary rounded-md p-0.5 shrink-0">
        <button onClick={() => setViewTab("monitor")} className={tabButton(viewTab === "monitor")}>
          Monitor
        </button>
        <button onClick={() => setViewTab("plot")} className={tabButton(viewTab === "plot")}>
          Plot
        </button>
      </div>

      <div className="w-px h-6 bg-can-border shrink-0" />

      {/* Main Controls */}
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          onClick={togglePause}
          className={`btn ${isPaused ? "btn-success" : "btn-secondary"} flex items-center gap-1.5 shrink-0`}
          title="Pause/resume the display (bus traffic continues)"
        >
          {isPaused ? <PlayIcon className="w-4 h-4" /> : <PauseIcon className="w-4 h-4" />}
          <span className="hidden md:inline">{isPaused ? "Resume" : "Pause"}</span>
        </button>

        <button
          onClick={clearMessages}
          className="btn btn-secondary flex items-center gap-1.5 shrink-0"
          title="Clear all received messages"
        >
          <TrashIcon className="w-4 h-4" />
          <span className="hidden md:inline">Clear</span>
        </button>

        {viewTab === "monitor" && (
          <>
            <div className="w-px h-6 bg-can-border mx-1 shrink-0" />

            {/* Receive view mode */}
            <div className="flex items-center bg-can-bg-tertiary rounded-md p-0.5 shrink-0">
              <button
                onClick={() => setViewMode("monitor")}
                className={tabButton(viewMode === "monitor")}
                title="Aggregated view: one row per message ID"
              >
                Overview
              </button>
              <button
                onClick={() => setViewMode("trace")}
                className={tabButton(viewMode === "trace")}
                title="Chronological view of every frame"
              >
                Trace
              </button>
            </div>

            {viewMode === "trace" && (
              <button
                onClick={toggleRecording}
                className={`btn flex items-center gap-1.5 shrink-0 ${
                  isRecording ? "btn-danger" : "btn-success"
                }`}
                disabled={!isRecording && !anyConnected}
                title={isRecording ? "Stop recording" : "Record live frames into the trace"}
              >
                {isRecording ? <StopIcon className="w-4 h-4" /> : <RecordIcon className="w-4 h-4" />}
                <span className="hidden md:inline">{isRecording ? "Stop" : "Record"}</span>
              </button>
            )}

            <div className="w-px h-6 bg-can-border mx-1 shrink-0" />

            <button
              onClick={handleExport}
              className="btn btn-secondary flex items-center gap-1.5 shrink-0"
              disabled={traceMessages.length === 0}
              title="Export the trace buffer as CSV"
            >
              <ArrowDownTrayIcon className="w-4 h-4" />
              <span className="hidden lg:inline">Export</span>
            </button>

            <button
              onClick={handleSaveProject}
              className="btn btn-secondary flex items-center gap-1.5 shrink-0"
              title="Save project (nets, filters, transmit list)"
            >
              <ArrowDownTrayIcon className="w-4 h-4" />
              <span className="hidden lg:inline">Save</span>
            </button>

            <button
              onClick={handleLoadProject}
              className="btn btn-secondary flex items-center gap-1.5 shrink-0"
              title="Open project"
            >
              <FolderOpenIcon className="w-4 h-4" />
              <span className="hidden lg:inline">Open</span>
            </button>
          </>
        )}
      </div>

      {/* Right - Version */}
      <div className="text-xs text-can-text-muted ml-auto shrink-0 hidden xl:block">v0.3.1</div>
    </header>
  );
}

