import { useEffect, useRef, useState, useMemo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useCanStore, CanFrame } from "../stores/canStore";
import { SignalSelector } from "./SignalSelector";
import { PauseIcon, PlayIcon, TrashIcon, XMarkIcon, FolderOpenIcon } from "./icons";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

// Color palette for signal lines
const SIGNAL_COLORS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#10b981", // green
  "#f59e0b", // amber
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#f97316", // orange
  "#6366f1", // indigo
];

export function PlotPanel() {
  const {
    selectedPlotSignals,
    plotData,
    isPlotPaused,
    plotTimeWindow,
    plotMaxDataPoints,
    removePlotSignal,
    clearPlotData,
    togglePlotPause,
    setPlotTimeWindow,
    setPlotData,
    channels,
    loadTrace,
    startPlayback,
    playbackState,
    loadedTraceFile,
    loadedDbcFiles,
  } = useCanStore();

  const chartRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [updateTimer, setUpdateTimer] = useState<number | null>(null);
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });

  const handleImportTrace = async () => {
    try {
      const filePath = await open({
        title: "Import Trace File",
        filters: [
          { name: "Trace Files", extensions: ["csv", "trc"] },
          { name: "CSV", extensions: ["csv"] },
          { name: "TRC", extensions: ["trc"] },
        ],
        multiple: false,
      });

      if (filePath && typeof filePath === "string") {
        console.log("Importing trace file:", filePath);
        const frameCount = await loadTrace(filePath);
        console.log(`Loaded ${frameCount} frames from trace file`);

        // Immediately decode all signals for selected signals and populate plot data
        if (selectedPlotSignals.length > 0) {
          console.log("Decoding all signals from trace file...");
          setIsLoadingTrace(true);
          setLoadingProgress({ current: 0, total: 0 });

          try {
            const allFrames = await invoke<CanFrame[]>("get_trace_frames");
            console.log(`Got ${allFrames.length} frames from trace`);
            setLoadingProgress({ current: 0, total: allFrames.length });

            // Decode signals for all matching frames
            const newPlotData = new Map<string, Array<{ time: number; value: number }>>();

            // Process in batches to avoid blocking
            const batchSize = 1000;
            for (let i = 0; i < allFrames.length; i += batchSize) {
              const batch = allFrames.slice(i, i + batchSize);
              
              for (const frame of batch) {
                // Find matching signals
                const matchingSignals = selectedPlotSignals.filter(
                  (sig) => sig.channelId === frame.channel && sig.messageId === frame.id
                );

                if (matchingSignals.length > 0 && loadedDbcFiles.has(frame.channel)) {
                  try {
                    const decodedSignals = await invoke<Array<{ name: string; physicalValue: number }>>("decode_message", {
                      channelId: frame.channel,
                      messageId: frame.id,
                      data: frame.data,
                    });

                    // Update data for each matching signal
                    for (const signal of matchingSignals) {
                      const decoded = decodedSignals.find((s) => s.name === signal.signalName);
                      if (decoded) {
                        const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
                        if (!newPlotData.has(key)) {
                          newPlotData.set(key, []);
                        }
                        newPlotData.get(key)!.push({ time: frame.timestamp, value: decoded.physicalValue });
                      }
                    }
                  } catch (error) {
                    // Silently skip decode errors
                  }
                }
              }

              // Update progress after each batch
              const processed = Math.min(i + batch.length, allFrames.length);
              setLoadingProgress({ current: processed, total: allFrames.length });
            }

            // Trim data points to max and time window
            const timeWindow = plotTimeWindow;
            const maxPoints = plotMaxDataPoints;
            const currentTime = allFrames.length > 0 ? allFrames[allFrames.length - 1].timestamp : 0;
            const cutoffTime = currentTime - timeWindow;

            for (const [key, dataPoints] of newPlotData.entries()) {
              let filtered = dataPoints.filter((pt) => pt.time >= cutoffTime);
              if (filtered.length > maxPoints) {
                filtered = filtered.slice(-maxPoints);
              }
              newPlotData.set(key, filtered);
            }

            // Update plot data in store
            setPlotData(newPlotData);
            console.log(`Decoded and plotted data for ${selectedPlotSignals.length} signals from ${allFrames.length} frames`);
          } finally {
            setIsLoadingTrace(false);
            setLoadingProgress({ current: 0, total: 0 });
          }
        }

        // Auto-start playback after loading (for real-time updates)
        const currentState = playbackState;
        if (currentState === "stopped") {
          await startPlayback();
        }
      }
    } catch (error) {
      console.error("Failed to import trace:", error);
    }
  };

  // Prepare data for uPlot
  const chartData = useMemo(() => {
    if (selectedPlotSignals.length === 0) {
      return { data: [[], []], series: [] };
    }

    // Collect all unique timestamps
    const timeSet = new Set<number>();
    for (const signal of selectedPlotSignals) {
      const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
      const data = plotData.get(key) || [];
      for (const point of data) {
        timeSet.add(point.time);
      }
    }

    // Sort timestamps
    const times = Array.from(timeSet).sort((a, b) => a - b);
    
    // Filter by time window
    if (times.length > 0) {
      const cutoffTime = times[times.length - 1] - plotTimeWindow;
      const filteredTimes = times.filter(t => t >= cutoffTime);
      
      // Build data arrays: [time, ...signal values]
      const data: (number | null)[][] = [filteredTimes];
      
      // Build series config
      const series: uPlot.Series[] = [];
      
      for (let i = 0; i < selectedPlotSignals.length; i++) {
        const signal = selectedPlotSignals[i];
        const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
        const signalData = plotData.get(key) || [];
        
        // Create a map for quick lookup
        const dataMap = new Map(signalData.map(p => [p.time, p.value]));
        
        // Build value array aligned with time array
        const values: (number | null)[] = filteredTimes.map(t => {
          const value = dataMap.get(t);
          return value !== undefined ? value : null;
        });
        
        data.push(values);
        
        // Get channel name for label
        const channelName = channels.find(c => c.id === signal.channelId)?.name || signal.channelId;
        const idHex = `0x${signal.messageId.toString(16).toUpperCase().padStart(3, "0")}`;
        const label = `${signal.signalName} (${idHex})`;
        
        series.push({
          label,
          stroke: SIGNAL_COLORS[i % SIGNAL_COLORS.length],
          width: 2,
          points: { show: false },
        });
      }
      
      return { data, series };
    }
    
    return { data: [[], []], series: [] };
  }, [selectedPlotSignals, plotData, plotTimeWindow, channels]);

  // Initialize/update uPlot chart
  useEffect(() => {
    if (!chartRef.current) return;

    const { data, series } = chartData;

    // Destroy existing chart
    if (plotRef.current) {
      plotRef.current.destroy();
      plotRef.current = null;
    }

    // Create new chart if we have data
    if (data[0].length > 0 && series.length > 0) {
      const opts: uPlot.Options = {
        width: chartRef.current.clientWidth,
        height: 400,
        scales: {
          x: {
            time: false,
            range: (u, dataMin, dataMax) => {
              // Show rolling window
              const maxTime = dataMax;
              const minTime = Math.max(dataMin, maxTime - plotTimeWindow);
              return [minTime, maxTime];
            },
          },
          y: {
            auto: true,
            range: (u, dataMin, dataMax) => {
              // Add some padding
              const padding = (dataMax - dataMin) * 0.1;
              return [dataMin - padding, dataMax + padding];
            },
          },
        },
        axes: [
          {
            stroke: "#6b7280",
            grid: { show: true, stroke: "#374151", width: 1 },
            ticks: { show: true, stroke: "#6b7280" },
            label: "Time (s)",
            labelFont: "12px system-ui",
            labelGap: 5,
            font: "11px system-ui",
            gap: 5,
          },
          {
            stroke: "#6b7280",
            grid: { show: true, stroke: "#374151", width: 1 },
            ticks: { show: true, stroke: "#6b7280" },
            label: "Value",
            labelFont: "12px system-ui",
            labelGap: 5,
            font: "11px system-ui",
            gap: 5,
          },
        ],
        series: [
          {
            label: "Time",
            value: (u, v) => v == null ? "--" : v.toFixed(3) + " s",
          },
          ...series,
        ],
        cursor: {
          show: true,
          x: true,
          y: true,
        },
        legend: {
          show: true,
          live: true,
        },
      };

      try {
        plotRef.current = new uPlot(opts, data, chartRef.current);
      } catch (error) {
        console.error("Failed to create uPlot chart:", error);
      }
    }

    // Cleanup on unmount
    return () => {
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
    };
  }, [chartData, plotTimeWindow]);

  // Throttled chart update (10Hz = 100ms)
  useEffect(() => {
    if (updateTimer) {
      clearTimeout(updateTimer);
    }

    const timer = window.setTimeout(() => {
      if (plotRef.current && !isPlotPaused) {
        const { data } = chartData;
        if (data[0].length > 0) {
          try {
            plotRef.current.setData(data, false);
          } catch (error) {
            console.error("Failed to update chart:", error);
          }
        }
      }
    }, 100);

    setUpdateTimer(timer);

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [chartData, isPlotPaused]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (plotRef.current && chartRef.current) {
        plotRef.current.setSize({
          width: chartRef.current.clientWidth,
          height: 400,
        });
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-can-bg-primary">
      {/* Header */}
      <div className="px-4 py-2 border-b border-can-border bg-can-bg-secondary">
        <h2 className="text-sm font-semibold text-can-text-primary">Signal Plotting</h2>
      </div>

      {/* Controls */}
      <div className="px-4 py-2 border-b border-can-border bg-can-bg-secondary flex items-center gap-2 flex-wrap">
        <SignalSelector />

        <div className="w-px h-6 bg-can-border" />

        <button
          onClick={handleImportTrace}
          className="btn btn-secondary flex items-center gap-2"
          disabled={isLoadingTrace}
        >
          <FolderOpenIcon className="w-4 h-4" />
          Import Trace
        </button>

        {loadedTraceFile && (
          <>
            <span className="text-xs text-can-text-muted truncate max-w-xs">
              {loadedTraceFile.split("/").pop() || loadedTraceFile}
            </span>
            {playbackState === "playing" && (
              <span className="text-xs text-can-accent-green flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-can-accent-green animate-pulse" />
                Playing
              </span>
            )}
            {playbackState === "paused" && (
              <span className="text-xs text-can-text-muted">Paused</span>
            )}
          </>
        )}

        <div className="w-px h-6 bg-can-border" />

        <button
          onClick={togglePlotPause}
          className={`btn flex items-center gap-2 ${isPlotPaused ? "btn-success" : "btn-secondary"}`}
        >
          {isPlotPaused ? (
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
          onClick={clearPlotData}
          className="btn btn-secondary flex items-center gap-2"
          disabled={selectedPlotSignals.length === 0}
        >
          <TrashIcon className="w-4 h-4" />
          Clear Data
        </button>

        <div className="w-px h-6 bg-can-border" />

        <label className="text-sm text-can-text-secondary flex items-center gap-2">
          Time Window:
          <select
            value={plotTimeWindow}
            onChange={(e) => setPlotTimeWindow(Number(e.target.value))}
            className="input text-sm px-2 py-1"
          >
            <option value={10}>10 s</option>
            <option value={20}>20 s</option>
            <option value={30}>30 s</option>
            <option value={60}>60 s</option>
          </select>
        </label>
      </div>

      {/* Loading Progress Bar */}
      {isLoadingTrace && (
        <div className="px-4 py-2 border-b border-can-border bg-can-bg-secondary">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-can-text-primary font-medium">
                  Decoding trace signals...
                </span>
                <span className="text-xs text-can-text-muted">
                  {loadingProgress.current.toLocaleString()} / {loadingProgress.total.toLocaleString()} frames
                  {loadingProgress.total > 0 && (
                    <span className="ml-2">
                      ({Math.round((loadingProgress.current / loadingProgress.total) * 100)}%)
                    </span>
                  )}
                </span>
              </div>
              <div className="w-full h-2 bg-can-bg-tertiary rounded-full overflow-hidden">
                <div
                  className="h-full bg-can-accent-blue transition-all duration-150 ease-out"
                  style={{
                    width: loadingProgress.total > 0
                      ? `${(loadingProgress.current / loadingProgress.total) * 100}%`
                      : "0%",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Selected Signals */}
      {selectedPlotSignals.length > 0 && (
        <div className="px-4 py-2 border-b border-can-border bg-can-bg-secondary">
          <div className="flex flex-wrap gap-2">
            {selectedPlotSignals.map((signal, idx) => {
              const channelName = channels.find(c => c.id === signal.channelId)?.name || signal.channelId;
              const idHex = `0x${signal.messageId.toString(16).toUpperCase().padStart(3, "0")}`;
              const color = SIGNAL_COLORS[idx % SIGNAL_COLORS.length];
              
              return (
                <div
                  key={`${signal.channelId}-${signal.messageId}-${signal.signalName}`}
                  className="flex items-center gap-1.5 px-2 py-1 bg-can-bg-tertiary rounded text-xs"
                >
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-can-text-primary font-medium">
                    {signal.signalName}
                  </span>
                  <span className="text-can-text-muted">
                    ({idHex})
                  </span>
                  <button
                    onClick={() => removePlotSignal(signal)}
                    className="ml-1 hover:text-can-accent-red transition-colors"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="flex-1 overflow-hidden p-4">
        {selectedPlotSignals.length === 0 ? (
          <div className="h-full flex items-center justify-center text-can-text-muted">
            <div className="text-center">
              <p className="text-sm mb-2">No signals selected</p>
              <p className="text-xs">Use "Add Signal" to start plotting</p>
            </div>
          </div>
        ) : (
          <div ref={chartRef} className="w-full h-full" />
        )}
      </div>
    </div>
  );
}

