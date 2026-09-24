import { useState } from "react";
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

type ExportFormat = "mcap" | "trc" | "csv";

const EXPORT_FORMATS: { id: ExportFormat; label: string }[] = [
  { id: "mcap", label: "MCAP" },
  { id: "trc", label: "TRC" },
  { id: "csv", label: "CSV" },
];

export function Toolbar() {
  const { isPaused, togglePause, clearMessages, viewMode, setViewMode, isRecording, toggleRecording, exportTrace, traceFrameCount, playbackFrameCount, saveProject, loadProject, viewTab, setViewTab } =
    useCanStore();
  const anyConnected = useAnyConnected();
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mcap");

  const handleExport = async () => {
    if (traceFrameCount === 0 && (isRecording || playbackFrameCount === 0)) return;
    const chosen = EXPORT_FORMATS.find((format) => format.id === exportFormat) ?? EXPORT_FORMATS[0];
    try {
      const filePath = await save({
        title: `Export ${chosen.label}`,
        filters: [{ name: chosen.label, extensions: [chosen.id] }],
        defaultPath: `can_trace_${new Date().toISOString().replace(/[:.]/g, "-")}.${chosen.id}`,
      });
      if (!filePath || typeof filePath !== "string") return;
      const path = filePath.toLowerCase().endsWith(`.${chosen.id}`)
        ? filePath
        : `${filePath}.${chosen.id}`;
      await exportTrace(path, chosen.id);
    } catch (error) {
      console.error("Failed to export trace:", error);
    }
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
          title="Pause the display. A background trace keeps recording."
        >
          {isPaused ? <PlayIcon className="w-4 h-4" /> : <PauseIcon className="w-4 h-4" />}
          <span className="hidden md:inline">{isPaused ? "Resume" : "Pause"}</span>
        </button>

        <button
          onClick={() => clearMessages().catch(console.error)}
          className="btn btn-secondary flex items-center gap-1.5 shrink-0"
          title="Clear the receive list and the retained trace"
        >
          <TrashIcon className="w-4 h-4" />
          <span className="hidden md:inline">Clear</span>
        </button>

        <button
          onClick={() => toggleRecording().catch(console.error)}
          className={`btn flex items-center gap-1.5 shrink-0 ${
            isRecording ? "btn-danger" : "btn-success"
          }`}
          disabled={!isRecording && !anyConnected}
          title={
            isRecording
              ? "Stop the background trace. Captured frames are kept."
              : "Record bus traffic in the background. Receive and transmit stay open."
          }
        >
          {isRecording ? <StopIcon className="w-4 h-4" /> : <RecordIcon className="w-4 h-4" />}
          <span className="hidden md:inline">{isRecording ? "Stop" : "Record"}</span>
        </button>

        <select
          value={exportFormat}
          onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
          className="select h-8 w-[5.5rem] py-0 text-xs shrink-0"
          title="Export format"
          aria-label="Export format"
        >
          {EXPORT_FORMATS.map((format) => (
            <option key={format.id} value={format.id}>
              {format.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => handleExport().catch(console.error)}
          className="btn btn-secondary flex items-center gap-1.5 shrink-0"
          disabled={traceFrameCount === 0 && (isRecording || playbackFrameCount === 0)}
          title={
            exportFormat === "mcap"
              ? "Export decoded can/Message topics, or can/0x… for unknown IDs"
              : exportFormat === "trc"
                ? "Export a PEAK TRC 2.1 trace"
                : "Export a CSV trace"
          }
        >
          <ArrowDownTrayIcon className="w-4 h-4" />
          <span className="hidden lg:inline">Export</span>
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

            <div className="w-px h-6 bg-can-border mx-1 shrink-0" />

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
      <div className="text-xs text-can-text-muted ml-auto shrink-0 hidden xl:block">v0.3.2</div>
    </header>
  );
}

