import { useEffect, useRef, useState, useMemo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useCanStore, CanFrame } from "../stores/canStore";
import { SignalSelector } from "./SignalSelector";
import { PauseIcon, PlayIcon, TrashIcon, XMarkIcon, FolderOpenIcon } from "./icons";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
    traceMessages,
    playbackState,
    loadedTraceFile,
    loadedDbcFiles,
  } = useCanStore();

  const chartRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [updateTimer, setUpdateTimer] = useState<number | null>(null);
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileLoadProgress, setFileLoadProgress] = useState(0);
  const traceStartTimeRef = useRef<number | null>(null); // Track trace start time for relative display

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
        // Reset trace start time when loading a new trace
        traceStartTimeRef.current = null;
        setIsLoadingFile(true);
        setFileLoadProgress(0);
        
        // Set up progress listener for file loading
        const unlistenProgress = await listen<number>("trace-load-progress", (event) => {
          setFileLoadProgress(event.payload);
        });
        
        let unlistenComplete: (() => void) | null = null;
        unlistenComplete = await listen<number>("trace-load-complete", async () => {
          if (unlistenProgress) unlistenProgress();
          if (unlistenComplete) unlistenComplete();
          setIsLoadingFile(false);
          setFileLoadProgress(0);
        });
        
        try {
          const frameCount = await loadTrace(filePath);
          // Trace file loaded - frames are already normalized and stored in traceMessages
          
          if (frameCount === undefined || frameCount === null) {
            console.error("loadTrace returned undefined/null. Check backend logs.");
            return;
          }

          // Immediately decode all signals for selected signals and populate plot data
          if (selectedPlotSignals.length === 0) {
            console.warn("No signals selected for plotting. Please add signals first.");
            return;
          }
          
          // Decoding signals
          setIsLoadingTrace(true);
          setLoadingProgress({ current: 0, total: 0 });

          try {
            // Use frames from store (already normalized) instead of calling get_trace_frames again
            // This avoids the IPC overhead and duplicate normalization
            // Get fresh from store after loadTrace completes
            const allFrames = useCanStore.getState().traceMessages;
            // Got frames from trace
            
            if (allFrames.length === 0) {
              console.error("No frames loaded from trace file. Check bus-to-channel mapping.");
              setIsLoadingTrace(false);
              return;
            }
            
            // Store the first timestamp as the trace start time (for relative time display)
            // Note: allFrames from loadTrace are already normalized (first frame = 0)
            // So traceStartTimeRef should be 0 for trace files
            traceStartTimeRef.current = 0;
            
            setLoadingProgress({ current: 0, total: allFrames.length });

            // Decode signals for all matching frames using batch processing
            const newPlotData = new Map<string, Array<{ time: number; value: number }>>();
            let decodedCount = 0;
            let skippedCount = 0;

            // Pre-compute lookup structures for O(1) access
            const signalKeyMap = new Map<string, Set<string>>(); // channelId -> Set<messageId>
            const signalNameMap = new Map<string, Set<string>>(); // `${channelId}-${messageId}` -> Set<signalName>
            const signalKeys = new Set<string>(); // All signal keys for quick lookup
            
            for (const sig of selectedPlotSignals) {
              if (!loadedDbcFiles.has(sig.channelId)) continue;
              
              const key = `${sig.channelId}-${sig.messageId}-${sig.signalName}`;
              signalKeys.add(key);
              
              if (!signalKeyMap.has(sig.channelId)) {
                signalKeyMap.set(sig.channelId, new Set());
              }
              signalKeyMap.get(sig.channelId)!.add(sig.messageId.toString());
              
              const msgKey = `${sig.channelId}-${sig.messageId}`;
              if (!signalNameMap.has(msgKey)) {
                signalNameMap.set(msgKey, new Set());
              }
              signalNameMap.get(msgKey)!.add(sig.signalName);
            }

            // Filter frames that match selected signals and have DBC files loaded
            const framesToDecode: Array<{ frame: CanFrame; signalNames: string[] }> = [];
            for (const frame of allFrames) {
              // Fast lookup: check if this channel/message combo has any selected signals
              const channelMsgs = signalKeyMap.get(frame.channel);
              if (channelMsgs && channelMsgs.has(frame.id.toString()) && loadedDbcFiles.has(frame.channel)) {
                const msgKey = `${frame.channel}-${frame.id}`;
                const signalNames = Array.from(signalNameMap.get(msgKey) || []);
                if (signalNames.length > 0) {
                  framesToDecode.push({ frame, signalNames });
                } else {
                  skippedCount++;
                }
              } else {
                skippedCount++;
              }
            }

            // Process in large batches for parallel decoding
            // Use larger batches for better parallelization, but yield to UI periodically
            const batchSize = 50000; // Larger batches = fewer IPC calls = better performance
            for (let i = 0; i < framesToDecode.length; i += batchSize) {
              const batch = framesToDecode.slice(i, i + batchSize);
              
              // Prepare batch decode request
              const decodeRequests = batch.map(({ frame }) => ({
                channel_id: frame.channel,
                message_id: frame.id,
                data: frame.data,
              }));

              try {
                // Batch decode all frames in parallel (backend uses rayon)
                const decodedResults = await invoke<Array<Array<{ name: string; physicalValue: number }>>>(
                  "decode_messages_batch",
                  { requests: decodeRequests }
                );

                // Process decoded results - optimized with pre-computed lookups
                // Note: frames from trace files are already normalized (first frame = 0)
                // So we can use timestamps directly
                for (let j = 0; j < batch.length; j++) {
                  const { frame, signalNames } = batch[j];
                  const decodedSignals = decodedResults[j];
                  
                  // Create a map for O(1) signal lookup
                  const decodedMap = new Map(decodedSignals.map(s => [s.name, s]));

                  // Update data for each matching signal
                  for (const signalName of signalNames) {
                    const decoded = decodedMap.get(signalName);
                    if (decoded) {
                      const key = `${frame.channel}-${frame.id}-${signalName}`;
                      if (!newPlotData.has(key)) {
                        newPlotData.set(key, []);
                      }
                      // Timestamps are already normalized (relative to trace start, starting at 0)
                      newPlotData.get(key)!.push({ time: frame.timestamp, value: decoded.physicalValue });
                      decodedCount++;
                    }
                  }
                }
              } catch (error) {
                skippedCount += batch.length;
                console.error(`Failed to decode batch starting at index ${i}:`, error);
              }

              // Update progress after each batch (throttled to avoid UI blocking)
              const processed = Math.min(i + batch.length, framesToDecode.length);
              setLoadingProgress({ current: processed, total: framesToDecode.length });
              
              // Yield to UI every few batches to prevent blocking
              if (i % (batchSize * 5) === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
              }
            }
            
            // Decoding complete - now process and downsample data
            // Trim data points to max and time window (if time window is set)
            // For very large datasets, downsample before storing to improve performance
            const timeWindow = plotTimeWindow;
            const maxPoints = plotMaxDataPoints;
            const maxStoredPoints = 100000; // Limit stored points to prevent memory issues
            // Frames are already normalized (starting at 0), so lastFrameTime is the duration
            const lastFrameTime = allFrames.length > 0 ? allFrames[allFrames.length - 1].timestamp : 0;
            const cutoffTime = timeWindow > 0 ? lastFrameTime - timeWindow : -Infinity;
            
            // Optimize: process all signals in one pass
            for (const [key, dataPoints] of newPlotData.entries()) {
              let filtered = dataPoints;
              
              // Only filter by time window if it's positive (not "All")
              if (timeWindow > 0 && dataPoints.length > 0) {
                // Use binary search for faster filtering on sorted data
                const firstValidIdx = dataPoints.findIndex(pt => pt.time >= cutoffTime);
                if (firstValidIdx > 0) {
                  filtered = dataPoints.slice(firstValidIdx);
                }
              }
              
              // Downsample if we have too many points (before applying maxPoints limit)
              if (filtered.length > maxStoredPoints) {
                // Simple downsampling: take every Nth point
                const step = Math.ceil(filtered.length / maxStoredPoints);
                filtered = filtered.filter((_, idx) => idx % step === 0 || idx === filtered.length - 1);
              }
              
              // Always limit to max points for performance (this is the display limit)
              if (filtered.length > maxPoints) {
                filtered = filtered.slice(-maxPoints);
              }
              newPlotData.set(key, filtered);
            }

            // Update plot data in store
            setPlotData(newPlotData);
            // Plot data updated
            
            if (newPlotData.size === 0) {
              console.error("No plot data was generated. Check that:");
              console.error("1. Signals are selected and match message IDs in the trace");
              console.error("2. DBC files are loaded on the correct channels");
              console.error("3. Bus-to-channel mapping is correct (Channel 1 -> Bus 1, Channel 3 -> Bus 3)");
            }
          } catch (error) {
            console.error("Error during signal decoding:", error);
          } finally {
            setIsLoadingTrace(false);
            setLoadingProgress({ current: 0, total: 0 });
          }

        // Don't auto-start playback - we've already loaded all the data
        // Playback would cause real-time updates which is slow for large traces
        } catch (error) {
          console.error("Failed to load trace file:", error);
          alert(`Failed to load trace file: ${error}`);
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

    // Data is already normalized (timestamps start at 0 for trace files)
    // For live data, timestamps are relative to connection start
    // So we can use timestamps directly without further normalization
    
    // Collect all unique timestamps from all signals
    const allTimesSet = new Set<number>();
    
    for (const signal of selectedPlotSignals) {
      const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
      const rawData = plotData.get(key) || [];
      
      for (const point of rawData) {
        allTimesSet.add(point.time);
      }
    }
    
    if (allTimesSet.size === 0) {
      return { data: [[], []], series: [] };
    }
    
    // Create sorted unified time array
    let unifiedTimes = Array.from(allTimesSet).sort((a, b) => a - b);
    
    // Filter by time window if needed (only if plotTimeWindow > 0, not for "All")
    if (plotTimeWindow > 0 && unifiedTimes.length > 0) {
      const cutoffTime = unifiedTimes[unifiedTimes.length - 1] - plotTimeWindow;
      unifiedTimes = unifiedTimes.filter(t => t >= cutoffTime);
    }
    
    // Downsample if we have too many points for performance
    // uPlot can handle large datasets, but 1.7M points is excessive
    // Note: Data should already be downsampled during loading, but we add a safety check here
    const maxDisplayPoints = 50000; // Reasonable limit for smooth rendering
    if (unifiedTimes.length > maxDisplayPoints) {
      // Simple downsampling: take every Nth point, keeping first and last
      const step = Math.ceil(unifiedTimes.length / maxDisplayPoints);
      unifiedTimes = unifiedTimes.filter((_, idx) => idx % step === 0 || idx === unifiedTimes.length - 1);
      // Downsampled for display
    }
    
    // Build data arrays: [time, ...signal values]
    const data: (number | null)[][] = [unifiedTimes];
    const series: uPlot.Series[] = [];
    
    for (let i = 0; i < selectedPlotSignals.length; i++) {
      const signal = selectedPlotSignals[i];
      const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
      const rawData = plotData.get(key) || [];
      
      if (rawData.length === 0) {
        // Signal has no data - fill with nulls
        data.push(new Array(unifiedTimes.length).fill(null));
      } else {
        // Sort this signal's data (timestamps are already normalized)
        const sortedData = rawData
          .map(p => ({ time: p.time, value: p.value }))
          .sort((a, b) => a.time - b.time);
        
        // Filter by time window if needed (only if plotTimeWindow > 0, not for "All")
        let filteredData = sortedData;
        if (plotTimeWindow > 0 && sortedData.length > 0) {
          const cutoffTime = sortedData[sortedData.length - 1].time - plotTimeWindow;
          filteredData = sortedData.filter(p => p.time >= cutoffTime);
        }
        
        // Downsample the signal data to match unifiedTimes if needed
        // This ensures we don't have more points than unifiedTimes
        let processedData = filteredData;
        if (filteredData.length > unifiedTimes.length * 2) {
          // Downsample by taking every Nth point
          const step = Math.ceil(filteredData.length / unifiedTimes.length);
          processedData = filteredData.filter((_, idx) => idx % step === 0 || idx === filteredData.length - 1);
        }
        
        // Create a map for quick lookup
        const dataMap = new Map(processedData.map(p => [p.time, p.value]));
        
        // Build value array aligned with unified time array
        // Forward-fill null values with the last known value
        const values: (number | null)[] = [];
        let lastValue: number | null = null;
        
        for (const t of unifiedTimes) {
          // Try exact match first
          let value = dataMap.get(t);
          
          // If no exact match, find nearest point (for downsampled data)
          if (value === undefined && processedData.length > 0) {
            // Binary search for nearest time
            let left = 0;
            let right = processedData.length - 1;
            while (left < right) {
              const mid = Math.floor((left + right) / 2);
              if (processedData[mid].time < t) {
                left = mid + 1;
              } else {
                right = mid;
              }
            }
            // Use the closest point
            if (left < processedData.length) {
              const dist1 = Math.abs(processedData[left].time - t);
              const dist2 = left > 0 ? Math.abs(processedData[left - 1].time - t) : Infinity;
              value = dist1 < dist2 ? processedData[left].value : processedData[left - 1].value;
            }
          }
          
          if (value !== undefined) {
            lastValue = value;
            values.push(value);
          } else {
            // Use last known value if available, otherwise null
            values.push(lastValue);
          }
        }
        
        data.push(values);
      }
      
      // Get channel name for label
      const channelName = channels.find(c => c.id === signal.channelId)?.name || signal.channelId;
      const idHex = `0x${signal.messageId.toString(16).toUpperCase().padStart(3, "0")}`;
      const label = `${signal.signalName} (${idHex})`;
      
        series.push({
          label,
          stroke: SIGNAL_COLORS[i % SIGNAL_COLORS.length],
          width: 2,
          points: { show: false },
          spanGaps: true, // Connect lines across null/missing values
          // Value formatter - v should never be null now since we forward-filled
          value: (u, v) => {
            return v == null ? "--" : v.toFixed(3);
          },
        });
    }
    
    return { data, series };
  }, [selectedPlotSignals, plotData, plotTimeWindow, channels, isLoadingTrace]);


  // Initialize/update uPlot chart
  useEffect(() => {
    // Don't update chart while loading trace - wait until all data is loaded
    if (isLoadingTrace) {
      return;
    }

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
              // Show all data if plotTimeWindow is -1, otherwise show rolling window
              if (plotTimeWindow < 0) {
                return [dataMin, dataMax];
              }
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
            values: (u, vals) => vals.map(v => {
              // Format time values nicely
              if (Math.abs(v) < 0.001) return "0";
              if (Math.abs(v) < 1) return v.toFixed(3) + " s";
              if (Math.abs(v) < 60) return v.toFixed(1) + " s";
              if (Math.abs(v) < 3600) return (v / 60).toFixed(1) + " min";
              return (v / 3600).toFixed(2) + " h";
            }),
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
            value: (u, v) => {
              if (v == null) return "--";
              // Format time values nicely in cursor
              if (Math.abs(v) < 0.001) return "0 s";
              if (Math.abs(v) < 1) return v.toFixed(3) + " s";
              if (Math.abs(v) < 60) return v.toFixed(1) + " s";
              if (Math.abs(v) < 3600) return (v / 60).toFixed(1) + " min";
              return (v / 3600).toFixed(2) + " h";
            },
          },
          ...series,
        ],
        cursor: {
          show: true,
          x: true,
          y: true,
          lock: true, // Keep cursor visible when mouse stops moving
          points: {
            show: true, // Show data points on cursor
            size: 4,
          },
          // uPlot automatically interpolates values between data points when focus.prox is not set
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
            <option value={300}>5 min</option>
            <option value={600}>10 min</option>
            <option value={-1}>All</option>
          </select>
        </label>
      </div>

      {/* File Loading Progress Bar */}
      {isLoadingFile && (
        <div className="px-4 py-2 border-b border-can-border bg-can-bg-secondary">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-can-text-primary font-medium">
                  Loading trace file...
                </span>
                <span className="text-xs text-can-text-muted">
                  {fileLoadProgress.toLocaleString()} lines parsed
                </span>
              </div>
              <div className="w-full bg-can-bg-tertiary rounded-full h-2">
                <div 
                  className="bg-can-accent-blue h-2 rounded-full transition-all duration-300"
                  style={{ width: fileLoadProgress > 0 ? `${Math.min(100, (fileLoadProgress / 1700000) * 100)}%` : '0%' }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Decoding Progress Bar */}
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
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedPlotSignals.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-can-text-muted">
            <div className="text-center">
              <p className="text-sm mb-2">No signals selected</p>
              <p className="text-xs">Use "Add Signal" to start plotting</p>
            </div>
          </div>
        ) : (
          <div ref={chartRef} className="flex-1 p-4" />
        )}
      </div>
    </div>
  );
}

