import { useCanStore } from "../stores/canStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  PlayIcon,
  PauseIcon,
  StopIcon,
  FolderOpenIcon,
  ArrowDownTrayIcon,
} from "./icons";

export function TraceManager() {
  const {
    isLogging,
    logFilePath,
    logFormat,
    playbackState,
    playbackSpeed,
    loadedTraceFile,
    playbackFrameCount,
    playbackCurrentIndex,
    connectionStatus,
    startLogging,
    stopLogging,
    loadTrace,
    startPlayback,
    stopPlayback,
    pausePlayback,
    resumePlayback,
    setPlaybackSpeed,
  } = useCanStore();

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

  const handleStopLogging = async () => {
    try {
      await stopLogging();
    } catch (error) {
      console.error("Failed to stop logging:", error);
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

  const handlePlaybackControl = async (action: "play" | "pause" | "stop") => {
    try {
      switch (action) {
        case "play":
          if (playbackState === "paused") {
            await resumePlayback();
          } else {
            await startPlayback();
          }
          break;
        case "pause":
          await pausePlayback();
          break;
        case "stop":
          await stopPlayback();
          break;
      }
    } catch (error) {
      console.error("Failed to control playback:", error);
    }
  };

  const handleSpeedChange = async (speed: number) => {
    try {
      await setPlaybackSpeed(speed);
    } catch (error) {
      console.error("Failed to set playback speed:", error);
    }
  };

  return (
    <div className="p-4 space-y-4 border-b border-can-border">
      <h3 className="text-sm font-semibold text-can-text-primary">Trace Management</h3>

      {/* Logging Section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-can-text-secondary">Logging</span>
          {isLogging && (
            <span className="text-xs text-can-accent-red">● Recording</span>
          )}
        </div>
        <div className="flex gap-2">
          {!isLogging ? (
            <button
              onClick={handleStartLogging}
              className="btn btn-success flex-1 text-xs"
              disabled={connectionStatus !== "connected"}
            >
              <ArrowDownTrayIcon className="w-3 h-3" />
              Start Logging
            </button>
          ) : (
            <button
              onClick={handleStopLogging}
              className="btn btn-danger flex-1 text-xs"
            >
              <StopIcon className="w-3 h-3" />
              Stop Logging
            </button>
          )}
        </div>
        {logFilePath && (
          <div className="text-xs text-can-text-muted truncate">
            {logFilePath.split("/").pop() || logFilePath}
          </div>
        )}
      </div>

      {/* Playback Section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-can-text-secondary">Playback</span>
          {loadedTraceFile && (
            <span className="text-xs text-can-text-muted">
              {playbackCurrentIndex} / {playbackFrameCount}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleLoadTrace}
            className="btn btn-secondary flex-1 text-xs"
          >
            <FolderOpenIcon className="w-3 h-3" />
            Load Trace
          </button>
        </div>

        {loadedTraceFile && (
          <>
            <div className="flex gap-2">
              <button
                onClick={() => handlePlaybackControl("play")}
                className="btn btn-success flex-1 text-xs"
                disabled={playbackState === "playing" && connectionStatus !== "connected"}
              >
                <PlayIcon className="w-3 h-3" />
                Play
              </button>
              <button
                onClick={() => handlePlaybackControl("pause")}
                className="btn btn-secondary text-xs"
                disabled={playbackState !== "playing"}
              >
                <PauseIcon className="w-3 h-3" />
              </button>
              <button
                onClick={() => handlePlaybackControl("stop")}
                className="btn btn-secondary text-xs"
                disabled={playbackState === "stopped"}
              >
                <StopIcon className="w-3 h-3" />
              </button>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-can-text-secondary">Speed</span>
                <span className="text-xs text-can-text-primary">{playbackSpeed.toFixed(1)}×</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="5"
                step="0.1"
                value={playbackSpeed}
                onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-xxs text-can-text-muted">
                <span>0.1×</span>
                <span>1×</span>
                <span>5×</span>
              </div>
            </div>

            <div className="text-xs text-can-text-muted truncate">
              {loadedTraceFile.split("/").pop() || loadedTraceFile}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

