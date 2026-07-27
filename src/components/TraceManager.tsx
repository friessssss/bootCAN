import { useCanStore, useAnyConnected } from "../stores/canStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  PlayIcon,
  PauseIcon,
  StopIcon,
  FolderOpenIcon,
  ArrowDownTrayIcon,
} from "./icons";

/** Compact trace logging + playback controls, shown above the trace list. */
export function TraceManager() {
  const {
    isLogging,
    logFilePath,
    playbackState,
    playbackSpeed,
    loadedTraceFile,
    playbackFrameCount,
    startLogging,
    stopLogging,
    loadTrace,
    startPlayback,
    stopPlayback,
    pausePlayback,
    resumePlayback,
    setPlaybackSpeed,
  } = useCanStore();
  const anyConnected = useAnyConnected();

  const handleStartLogging = async () => {
    try {
      const filePath = await save({
        title: "Save Trace File",
        filters: [
          { name: "CSV", extensions: ["csv"] },
          { name: "TRC", extensions: ["trc"] },
        ],
        defaultPath: `can_trace_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
      });

      if (filePath) {
        const format = filePath.endsWith(".trc") ? "trc" : "csv";
        await startLogging(filePath, format);
      }
    } catch (error) {
      console.error("Failed to start logging:", error);
    }
  };

  const handleLoadTrace = async () => {
    try {
      const filePath = await open({
        title: "Load Trace File",
        filters: [
          { name: "Trace Files", extensions: ["csv", "trc"] },
          { name: "CSV", extensions: ["csv"] },
          { name: "TRC", extensions: ["trc"] },
        ],
        multiple: false,
      });

      if (filePath && typeof filePath === "string") {
        await loadTrace(filePath);
      }
    } catch (error) {
      console.error("Failed to load trace:", error);
    }
  };

  const handlePlay = async () => {
    try {
      if (playbackState === "paused") await resumePlayback();
      else await startPlayback();
    } catch (error) {
      console.error("Failed to start playback:", error);
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 w-full flex-wrap">
      {/* Logging to file */}
      {!isLogging ? (
        <button
          onClick={handleStartLogging}
          className="btn btn-secondary h-6 text-xs flex items-center gap-1"
          disabled={!anyConnected}
          title="Log incoming frames to a CSV/TRC file"
        >
          <ArrowDownTrayIcon className="w-3 h-3" />
          Log to File
        </button>
      ) : (
        <button
          onClick={() => stopLogging().catch(console.error)}
          className="btn btn-danger h-6 text-xs flex items-center gap-1"
          title={logFilePath ?? undefined}
        >
          <StopIcon className="w-3 h-3" />
          Stop Logging
        </button>
      )}

      <div className="w-px h-4 bg-can-border" />

      {/* Playback */}
      <button
        onClick={handleLoadTrace}
        className="btn btn-secondary h-6 text-xs flex items-center gap-1"
      >
        <FolderOpenIcon className="w-3 h-3" />
        Load Trace
      </button>

      {loadedTraceFile && (
        <>
          <button
            onClick={handlePlay}
            className="btn btn-success h-6 text-xs flex items-center gap-1"
            disabled={playbackState === "playing"}
          >
            <PlayIcon className="w-3 h-3" />
            Play
          </button>
          <button
            onClick={() => pausePlayback().catch(console.error)}
            className="btn btn-secondary h-6 text-xs"
            disabled={playbackState !== "playing"}
          >
            <PauseIcon className="w-3 h-3" />
          </button>
          <button
            onClick={() => stopPlayback().catch(console.error)}
            className="btn btn-secondary h-6 text-xs"
            disabled={playbackState === "stopped"}
          >
            <StopIcon className="w-3 h-3" />
          </button>

          <label className="flex items-center gap-1.5 text-xs text-can-text-secondary ml-1">
            Speed
            <input
              type="range"
              min="0.1"
              max="5"
              step="0.1"
              value={playbackSpeed}
              onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value)).catch(console.error)}
              className="w-20"
            />
            <span className="w-8 text-can-text-primary">{playbackSpeed.toFixed(1)}×</span>
          </label>

          <span
            className="text-xxs text-can-text-muted truncate max-w-48 ml-auto"
            title={loadedTraceFile}
          >
            {loadedTraceFile.split("/").pop()} · {playbackFrameCount.toLocaleString()} frames
          </span>
        </>
      )}
    </div>
  );
}
