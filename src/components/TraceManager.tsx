import { useCanStore } from "../stores/canStore";
import { open } from "@tauri-apps/plugin-dialog";
import { PlayIcon, PauseIcon, StopIcon, FolderOpenIcon } from "./icons";

/** Compact trace logging + playback controls, shown above the trace list. */
export function TraceManager() {
  const {
    playbackState,
    playbackSpeed,
    loadedTraceFile,
    playbackFrameCount,
    loadTrace,
    startPlayback,
    stopPlayback,
    pausePlayback,
    resumePlayback,
    setPlaybackSpeed,
  } = useCanStore();

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
