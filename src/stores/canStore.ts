import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type {
  BusStats,
  CanFrame,
  ConnectionStatus,
  DecodedSignal,
  InterfaceInfo,
  MonitorEntry,
  MonitorSort,
  Net,
  PlotDataPoint,
  PlotSignal,
  TransmitRow,
} from "../types/can";
import type { ProjectFile, ProjectNet, ProjectTransmitRow } from "../types/project";

export type {
  BusStats,
  CanFrame,
  ConnectionStatus,
  InterfaceInfo,
  MonitorEntry,
  Net,
  PlotDataPoint,
  PlotSignal,
  TransmitRow,
} from "../types/can";

interface CanState {
  // Detected hardware / virtual interfaces (auto-updated on hot-plug)
  availableInterfaces: InterfaceInfo[];

  // Nets: named bus definitions, optionally bound to a detected device
  nets: Net[];
  activeNetId: string | null;

  // Filter rules (mirrors backend FilterSet per active net)
  filters: Array<{ type: string; [key: string]: any }>;

  // Message buffers
  traceMessages: CanFrame[];
  monitorMessages: Map<string, MonitorEntry>;
  maxMessages: number;
  isPaused: boolean;

  // Monitor list presentation
  monitorSort: MonitorSort;
  idFilter: string;
  expandedRows: Set<string>; // monitor keys with signal sub-rows expanded

  // Symbolic names: net id -> (message id -> name)
  messageNames: Map<string, Map<number, string>>;

  // Recording state for trace
  isRecording: boolean;
  recordingStartTime: number | null;

  // Trace logging state
  isLogging: boolean;
  logFilePath: string | null;
  logFormat: "csv" | "trc";

  // Trace playback state
  playbackState: "stopped" | "playing" | "paused";
  playbackSpeed: number;
  loadedTraceFile: string | null;
  playbackFrameCount: number;

  // Bus statistics per net
  busStats: Map<string, BusStats>;

  // Transmit list (PCX7-style rows)
  transmitRows: TransmitRow[];
  selectedTransmitRowId: string | null;

  // View state
  viewMode: "trace" | "monitor";
  viewTab: "monitor" | "plot";

  // Plot state
  selectedPlotSignals: PlotSignal[];
  plotData: Map<string, PlotDataPoint[]>;
  isPlotPaused: boolean;
  plotTimeWindow: number; // seconds; -1 = all
  plotMaxDataPoints: number;

  // --- Actions ---
  initializeBackend: () => Promise<void>;

  // Messages
  clearMessages: () => void;
  togglePause: () => void;
  setIdFilter: (filter: string) => void;
  setMonitorSort: (sort: MonitorSort) => void;
  toggleRowExpanded: (key: string) => void;
  setViewMode: (mode: "trace" | "monitor") => void;
  setViewTab: (tab: "monitor" | "plot") => void;

  // Recording
  toggleRecording: () => void;
  stopRecording: () => void;

  // Trace logging
  startLogging: (filePath: string, format: "csv" | "trc") => Promise<void>;
  stopLogging: () => Promise<void>;

  // Trace playback
  loadTrace: (filePath: string) => Promise<number>;
  startPlayback: () => Promise<void>;
  stopPlayback: () => Promise<void>;
  pausePlayback: () => Promise<void>;
  resumePlayback: () => Promise<void>;
  setPlaybackSpeed: (speed: number) => Promise<void>;

  // Nets
  addNet: () => void;
  removeNet: (id: string) => Promise<void>;
  updateNet: (id: string, updates: Partial<Omit<Net, "id" | "connectionStatus">>) => void;
  setActiveNet: (id: string) => void;
  connectNet: (id: string) => Promise<void>;
  disconnectNet: (id: string) => Promise<void>;
  loadSymbolFile: (netId: string, filePath: string) => Promise<void>;
  removeSymbolFile: (netId: string) => void;

  // Transmit
  sendFrame: (frame: {
    id: number;
    isExtended: boolean;
    isRemote: boolean;
    dlc: number;
    data: number[];
    channel?: string;
  }) => Promise<void>;
  addTransmitRow: (row: Omit<TransmitRow, "id" | "count" | "manualCount" | "paused" | "backendJobId">) => string;
  updateTransmitRow: (id: string, updates: Partial<Omit<TransmitRow, "id">>) => Promise<void>;
  removeTransmitRow: (id: string) => Promise<void>;
  toggleTransmitRowPaused: (id: string) => Promise<void>;
  sendTransmitRowOnce: (id: string) => Promise<void>;
  setSelectedTransmitRow: (id: string | null) => void;

  // Filters
  setFilters: (filters: Array<{ type: string; [key: string]: any }>) => void;

  // Project
  saveProject: (filePath: string) => Promise<void>;
  loadProject: (filePath: string) => Promise<void>;

  // Plot
  addPlotSignal: (signal: PlotSignal) => void;
  removePlotSignal: (signal: PlotSignal) => void;
  clearPlotData: () => void;
  togglePlotPause: () => void;
  setPlotTimeWindow: (window: number) => void;
  setPlotData: (data: Map<string, PlotDataPoint[]>) => void;
}

// Event listener cleanup
let unlistenBatch: UnlistenFn | null = null;
let unlistenStats: UnlistenFn | null = null;
let unlistenInterfaces: UnlistenFn | null = null;
let unlistenChannelError: UnlistenFn | null = null;
let txCountTimer: ReturnType<typeof setInterval> | null = null;
let isInitialized = false;

function rowToFramePayload(row: TransmitRow) {
  return {
    id: row.canId,
    isExtended: row.isExtended,
    isRemote: row.isRemote,
    dlc: row.dlc,
    data: row.data.slice(0, row.dlc),
    channel: row.netId ?? undefined,
  };
}

export const useCanStore = create<CanState>((set, get) => ({
  availableInterfaces: [],
  nets: [],
  activeNetId: null,
  filters: [],
  traceMessages: [],
  monitorMessages: new Map<string, MonitorEntry>(),
  maxMessages: 10000,
  isPaused: false,
  monitorSort: { key: "id", dir: "asc" },
  idFilter: "",
  expandedRows: new Set<string>(),
  messageNames: new Map<string, Map<number, string>>(),
  isRecording: false,
  recordingStartTime: null,
  isLogging: false,
  logFilePath: null,
  logFormat: "csv",
  playbackState: "stopped",
  playbackSpeed: 1.0,
  loadedTraceFile: null,
  playbackFrameCount: 0,
  busStats: new Map<string, BusStats>(),
  transmitRows: [],
  selectedTransmitRowId: null,
  viewMode: "monitor",
  viewTab: "monitor",
  selectedPlotSignals: [],
  plotData: new Map<string, PlotDataPoint[]>(),
  isPlotPaused: false,
  plotTimeWindow: -1,
  plotMaxDataPoints: 5000,

  initializeBackend: async () => {
    // Prevent duplicate initialization (React StrictMode calls effects twice)
    if (isInitialized) return;
    isInitialized = true;

    try {
      const interfaces = await invoke<InterfaceInfo[]>("get_interfaces");
      set({ availableInterfaces: interfaces });

      // Hot-plug: the backend re-enumerates every 2s and emits on changes
      unlistenInterfaces = await listen<InterfaceInfo[]>("interfaces-changed", (event) => {
        set({ availableInterfaces: event.payload });
      });

      // A connected channel died (e.g. device unplugged)
      unlistenChannelError = await listen<{ channelId: string; error: string }>(
        "channel-error",
        (event) => {
          const { channelId, error } = event.payload;
          console.warn(`Net ${channelId} failed: ${error}`);
          set((s) => ({
            nets: s.nets.map((n) =>
              n.id === channelId ? { ...n, connectionStatus: "error" } : n
            ),
          }));
        }
      );

      // Batched frame delivery (~30 Hz): one store update per batch
      unlistenBatch = await listen<CanFrame[]>("can-message-batch", (event) => {
        const state = get();
        if (state.isPaused) return;
        const frames = event.payload;
        if (frames.length === 0) return;

        const isTracePlayback =
          state.loadedTraceFile !== null &&
          (state.playbackState === "playing" || state.playbackState === "paused");
        const now = performance.now();

        set((s) => {
          let newMonitor = s.monitorMessages;
          if (!isTracePlayback) {
            newMonitor = new Map(s.monitorMessages);
            for (const frame of frames) {
              const key = `${frame.channel}-${frame.id}-${frame.direction}`;
              const existing = newMonitor.get(key);
              if (existing) {
                const dtMs = (frame.timestamp - existing.lastTimestamp) * 1000;
                // EMA smoothing so the display doesn't flicker
                const cycleTime =
                  existing.cycleTime > 0 && dtMs > 0
                    ? existing.cycleTime * 0.8 + dtMs * 0.2
                    : dtMs > 0
                      ? dtMs
                      : existing.cycleTime;
                const changedAt = existing.changedAt.slice();
                const prevData = existing.frame.data;
                for (let i = 0; i < frame.data.length; i++) {
                  if (prevData[i] !== frame.data[i]) changedAt[i] = now;
                }
                newMonitor.set(key, {
                  frame,
                  count: existing.count + 1,
                  cycleTime,
                  lastTimestamp: frame.timestamp,
                  changedAt,
                });
              } else {
                newMonitor.set(key, {
                  frame,
                  count: 1,
                  cycleTime: 0,
                  lastTimestamp: frame.timestamp,
                  changedAt: new Array(8).fill(0),
                });
              }
            }
          }

          let newTrace = s.traceMessages;
          let newStart = s.recordingStartTime;
          if (s.isRecording && !isTracePlayback) {
            if (newStart === null) newStart = frames[0].timestamp;
            const base = newStart;
            const rebased = frames.map((f) => ({ ...f, timestamp: f.timestamp - base }));
            newTrace = [...s.traceMessages, ...rebased].slice(-s.maxMessages);
          }

          return {
            monitorMessages: newMonitor,
            traceMessages: newTrace,
            recordingStartTime: newStart,
          };
        });

        // Plot decoding: one batched invoke per flush
        const st = get();
        if (!st.isPlotPaused && st.selectedPlotSignals.length > 0 && !isTracePlayback) {
          const wanted = new Set(
            st.selectedPlotSignals.map((sig) => `${sig.channelId}-${sig.messageId}`)
          );
          const matchingFrames = frames.filter((f) => wanted.has(`${f.channel}-${f.id}`));
          if (matchingFrames.length > 0) {
            const requests = matchingFrames.map((f) => ({
              channelId: f.channel,
              messageId: f.id,
              data: f.data,
            }));
            invoke<DecodedSignal[][]>("decode_messages_batch", { requests })
              .then((results) => {
                set((s) => {
                  const newPlotData = new Map(s.plotData);
                  const timeWindow = s.plotTimeWindow;
                  const maxPoints = s.plotMaxDataPoints;
                  results.forEach((decoded, i) => {
                    const frame = matchingFrames[i];
                    for (const sig of s.selectedPlotSignals) {
                      if (sig.channelId !== frame.channel || sig.messageId !== frame.id) continue;
                      const d = decoded.find((x) => x.name === sig.signalName);
                      if (!d) continue;
                      const key = `${sig.channelId}-${sig.messageId}-${sig.signalName}`;
                      let points = newPlotData.get(key) ?? [];
                      points = [...points, { time: frame.timestamp, value: d.physicalValue }];
                      if (timeWindow > 0) {
                        const cutoff = frame.timestamp - timeWindow;
                        points = points.filter((pt) => pt.time >= cutoff);
                      }
                      if (points.length > maxPoints) points = points.slice(-maxPoints);
                      newPlotData.set(key, points);
                    }
                  });
                  return { plotData: newPlotData };
                });
              })
              .catch(() => {
                // Decoding failed (no symbol file?) — skip silently
              });
          }
        }
      });

      // Per-net bus statistics
      unlistenStats = await listen<BusStats & { channelId: string }>("bus-stats", (event) => {
        const { channelId, ...stats } = event.payload;
        set((s) => {
          const newStats = new Map(s.busStats);
          newStats.set(channelId, stats);
          return { busStats: newStats };
        });
      });

      // Poll cyclic transmit counts while jobs run
      txCountTimer = setInterval(async () => {
        const rows = get().transmitRows;
        if (!rows.some((r) => r.backendJobId)) return;
        try {
          const counts = await invoke<Record<string, u64Number>>("get_periodic_tx_counts");
          set((s) => ({
            transmitRows: s.transmitRows.map((r) =>
              r.backendJobId && counts[r.backendJobId] !== undefined
                ? { ...r, count: r.manualCount + counts[r.backendJobId] }
                : r
            ),
          }));
        } catch {
          // ignore
        }
      }, 500);
    } catch (error) {
      console.error("Failed to initialize backend:", error);
      isInitialized = false; // Allow retry on error
    }
  },

  clearMessages: () =>
    set({
      traceMessages: [],
      monitorMessages: new Map<string, MonitorEntry>(),
      expandedRows: new Set<string>(),
    }),

  togglePause: () => set((s) => ({ isPaused: !s.isPaused })),
  setIdFilter: (filter: string) => set({ idFilter: filter }),
  setMonitorSort: (sort) => set({ monitorSort: sort }),
  toggleRowExpanded: (key: string) =>
    set((s) => {
      const next = new Set(s.expandedRows);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { expandedRows: next };
    }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setViewTab: (tab) => set({ viewTab: tab }),

  toggleRecording: () => {
    const state = get();
    if (state.isRecording) {
      set({ isRecording: false, recordingStartTime: null });
    } else {
      set({ isRecording: true, recordingStartTime: null, traceMessages: [] });
    }
  },

  stopRecording: () => set({ isRecording: false, recordingStartTime: null }),

  startLogging: async (filePath, format) => {
    await invoke("start_logging", { filePath, format });
    set({ isLogging: true, logFilePath: filePath, logFormat: format });
  },

  stopLogging: async () => {
    await invoke("stop_logging");
    set({ isLogging: false, logFilePath: null });
  },

  loadTrace: async (filePath: string) => {
    const state = get();
    // Map TRC bus numbers to nets: bus N -> Nth net (by name number when present)
    const busToChannelNameMap: Record<string, string> = {};
    const channelNameToIdMap: Record<string, string> = {};
    state.nets.forEach((net, index) => {
      channelNameToIdMap[net.name] = net.id;
      const match = net.name.match(/\d+/);
      const busNum = match ? parseInt(match[0], 10) : index + 1;
      if (busNum > 0 && busNum <= 255) busToChannelNameMap[busNum.toString()] = net.name;
    });

    const count = await invoke<number>("load_trace", {
      filePath,
      busToChannelMap:
        Object.keys(busToChannelNameMap).length > 0 ? busToChannelNameMap : undefined,
      channelNameToIdMap:
        Object.keys(channelNameToIdMap).length > 0 ? channelNameToIdMap : undefined,
    });

    const allFrames = await invoke<CanFrame[]>("get_trace_frames");
    const firstTimestamp = allFrames.length > 0 ? allFrames[0].timestamp : 0;
    const traceFrames = allFrames.map((frame) => ({
      ...frame,
      timestamp: frame.timestamp - firstTimestamp,
    }));

    set({
      loadedTraceFile: filePath,
      playbackFrameCount: count,
      traceMessages: traceFrames,
    });
    return count;
  },

  startPlayback: async () => {
    await invoke("start_playback");
    set({ playbackState: "playing" });
  },

  stopPlayback: async () => {
    await invoke("stop_playback");
    set({ playbackState: "stopped" });
  },

  pausePlayback: async () => {
    await invoke("pause_playback");
    set({ playbackState: "paused" });
  },

  resumePlayback: async () => {
    await invoke("resume_playback");
    set({ playbackState: "playing" });
  },

  setPlaybackSpeed: async (speed: number) => {
    await invoke("set_playback_speed", { speed });
    set({ playbackSpeed: speed });
  },

  // --- Nets ---

  addNet: () => {
    const id = `net_${Date.now()}`;
    set((s) => ({
      nets: [
        ...s.nets,
        {
          id,
          name: `Net ${s.nets.length + 1}`,
          bitrate: 500000,
          assignedDeviceId: null,
          symbolFilePath: null,
          connectionStatus: "disconnected",
        },
      ],
      activeNetId: s.activeNetId ?? id,
    }));
  },

  removeNet: async (id: string) => {
    const net = get().nets.find((n) => n.id === id);
    if (net && net.connectionStatus === "connected") {
      await get().disconnectNet(id);
    }
    set((s) => {
      const nets = s.nets.filter((n) => n.id !== id);
      return {
        nets,
        activeNetId:
          s.activeNetId === id ? (nets.length > 0 ? nets[0].id : null) : s.activeNetId,
      };
    });
  },

  updateNet: (id, updates) =>
    set((s) => ({
      nets: s.nets.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    })),

  setActiveNet: (id: string) => set({ activeNetId: id }),

  connectNet: async (id: string) => {
    const net = get().nets.find((n) => n.id === id);
    if (!net || !net.assignedDeviceId) return;

    set((s) => ({
      nets: s.nets.map((n) => (n.id === id ? { ...n, connectionStatus: "connecting" } : n)),
    }));

    try {
      await invoke("connect_channel", {
        channelId: id,
        interfaceId: net.assignedDeviceId,
        bitrate: net.bitrate,
      });
      set((s) => ({
        nets: s.nets.map((n) => (n.id === id ? { ...n, connectionStatus: "connected" } : n)),
      }));
    } catch (error) {
      console.error("Failed to connect net:", error);
      set((s) => ({
        nets: s.nets.map((n) => (n.id === id ? { ...n, connectionStatus: "error" } : n)),
      }));
      throw error;
    }
  },

  disconnectNet: async (id: string) => {
    try {
      await invoke("disconnect_channel", { channelId: id });
    } catch (error) {
      console.error("Failed to disconnect net:", error);
    }
    set((s) => ({
      nets: s.nets.map((n) => (n.id === id ? { ...n, connectionStatus: "disconnected" } : n)),
    }));
  },

  loadSymbolFile: async (netId: string, filePath: string) => {
    await invoke("load_dbc", { channelId: netId, filePath });
    const names = await invoke<Record<string, string>>("get_message_names", {
      channelId: netId,
    });
    set((s) => {
      const nameMap = new Map<number, string>();
      for (const [idStr, name] of Object.entries(names)) {
        nameMap.set(Number(idStr), name);
      }
      const newNames = new Map(s.messageNames);
      newNames.set(netId, nameMap);
      return {
        messageNames: newNames,
        nets: s.nets.map((n) => (n.id === netId ? { ...n, symbolFilePath: filePath } : n)),
      };
    });
  },

  removeSymbolFile: (netId: string) =>
    set((s) => {
      const newNames = new Map(s.messageNames);
      newNames.delete(netId);
      return {
        messageNames: newNames,
        nets: s.nets.map((n) => (n.id === netId ? { ...n, symbolFilePath: null } : n)),
      };
    }),

  // --- Transmit ---

  sendFrame: async (frame) => {
    await invoke("send_message", { frame });
  },

  addTransmitRow: (row) => {
    const id = crypto.randomUUID();
    set((s) => ({
      transmitRows: [
        ...s.transmitRows,
        { ...row, id, paused: true, count: 0, manualCount: 0 },
      ],
      selectedTransmitRowId: id,
    }));
    return id;
  },

  updateTransmitRow: async (id, updates) => {
    const row = get().transmitRows.find((r) => r.id === id);
    if (!row) return;
    const merged = { ...row, ...updates };

    if (row.backendJobId) {
      const cycleChanged = updates.cycleMs !== undefined && updates.cycleMs !== row.cycleMs;
      const netChanged = updates.netId !== undefined && updates.netId !== row.netId;
      if (cycleChanged || netChanged || merged.cycleMs <= 0) {
        // Interval/target changes restart the job
        try {
          await invoke("stop_periodic_transmit", { jobId: row.backendJobId });
        } catch (e) {
          console.error("Failed to stop periodic transmit:", e);
        }
        merged.backendJobId = undefined;
        if (merged.cycleMs > 0 && !merged.paused) {
          try {
            merged.backendJobId = await invoke<string>("start_periodic_transmit", {
              frame: rowToFramePayload(merged),
              intervalMs: merged.cycleMs,
            });
          } catch (e) {
            console.error("Failed to restart periodic transmit:", e);
            merged.paused = true;
          }
        }
      } else {
        // Data-only edit: update the running job in place (no glitch)
        try {
          await invoke("update_periodic_transmit", {
            jobId: row.backendJobId,
            frame: rowToFramePayload(merged),
          });
        } catch (e) {
          console.error("Failed to update periodic transmit:", e);
        }
      }
    }

    set((s) => ({
      transmitRows: s.transmitRows.map((r) => (r.id === id ? merged : r)),
    }));
  },

  removeTransmitRow: async (id: string) => {
    const row = get().transmitRows.find((r) => r.id === id);
    if (row?.backendJobId) {
      try {
        await invoke("stop_periodic_transmit", { jobId: row.backendJobId });
      } catch (e) {
        console.error("Failed to stop periodic transmit:", e);
      }
    }
    set((s) => ({
      transmitRows: s.transmitRows.filter((r) => r.id !== id),
      selectedTransmitRowId: s.selectedTransmitRowId === id ? null : s.selectedTransmitRowId,
    }));
  },

  toggleTransmitRowPaused: async (id: string) => {
    const row = get().transmitRows.find((r) => r.id === id);
    if (!row || row.cycleMs <= 0) return;

    if (row.backendJobId) {
      // Running -> pause
      try {
        await invoke("stop_periodic_transmit", { jobId: row.backendJobId });
      } catch (e) {
        console.error("Failed to stop periodic transmit:", e);
      }
      set((s) => ({
        transmitRows: s.transmitRows.map((r) =>
          r.id === id ? { ...r, paused: true, backendJobId: undefined } : r
        ),
      }));
    } else {
      // Paused -> run (needs a connected net)
      const net = get().nets.find((n) => n.id === row.netId);
      if (!net || net.connectionStatus !== "connected") {
        console.warn("Cannot start cyclic transmit: net not connected");
        return;
      }
      try {
        const backendJobId = await invoke<string>("start_periodic_transmit", {
          frame: rowToFramePayload(row),
          intervalMs: row.cycleMs,
        });
        set((s) => ({
          transmitRows: s.transmitRows.map((r) =>
            r.id === id ? { ...r, paused: false, backendJobId } : r
          ),
        }));
      } catch (e) {
        console.error("Failed to start periodic transmit:", e);
      }
    }
  },

  sendTransmitRowOnce: async (id: string) => {
    const row = get().transmitRows.find((r) => r.id === id);
    if (!row) return;
    const net = get().nets.find((n) => n.id === row.netId);
    if (!net || net.connectionStatus !== "connected") return;
    try {
      await invoke("send_message", { frame: rowToFramePayload(row) });
      set((s) => ({
        transmitRows: s.transmitRows.map((r) =>
          r.id === id
            ? { ...r, manualCount: r.manualCount + 1, count: r.count + 1 }
            : r
        ),
      }));
    } catch (e) {
      console.error("Failed to send frame:", e);
    }
  },

  setSelectedTransmitRow: (id) => set({ selectedTransmitRowId: id }),

  setFilters: (filters) => set({ filters }),

  // --- Project ---

  saveProject: async (filePath: string) => {
    const state = get();
    const nets: ProjectNet[] = state.nets.map((n) => ({
      id: n.id,
      name: n.name,
      bitrate: n.bitrate,
      assignedDeviceId: n.assignedDeviceId,
      symbolFilePath: n.symbolFilePath,
      comment: n.comment ?? null,
    }));
    const filters = state.filters.map((f) => ({ data: f }));
    const transmitRows: ProjectTransmitRow[] = state.transmitRows.map((r) => ({
      id: r.id,
      name: r.name,
      comment: r.comment,
      netId: r.netId,
      canId: r.canId,
      isExtended: r.isExtended,
      isRemote: r.isRemote,
      dlc: r.dlc,
      data: r.data,
      cycleMs: r.cycleMs,
      signalValues: r.signalValues ?? null,
    }));

    await invoke("save_project", { filePath, nets, filters, transmitRows });
  },

  loadProject: async (filePath: string) => {
    const project = await invoke<ProjectFile>("load_project", { filePath });

    const nets: Net[] = project.nets.map((n) => ({
      id: n.id,
      name: n.name,
      bitrate: n.bitrate,
      assignedDeviceId: n.assignedDeviceId,
      symbolFilePath: n.symbolFilePath,
      comment: n.comment ?? undefined,
      connectionStatus: "disconnected" as ConnectionStatus,
    }));

    const transmitRows: TransmitRow[] = project.transmitRows.map((r) => ({
      id: r.id,
      name: r.name,
      comment: r.comment,
      netId: r.netId,
      canId: r.canId,
      isExtended: r.isExtended,
      isRemote: r.isRemote,
      dlc: r.dlc,
      data: r.data,
      cycleMs: r.cycleMs,
      paused: true,
      count: 0,
      manualCount: 0,
      signalValues: r.signalValues ?? undefined,
    }));

    set({
      nets,
      filters: project.filters.map((f) => f.data),
      transmitRows,
      activeNetId: nets.length > 0 ? nets[0].id : null,
      messageNames: new Map(),
    });

    // Load symbol files (also updates the backend databases)
    for (const net of nets) {
      if (net.symbolFilePath) {
        try {
          await get().loadSymbolFile(net.id, net.symbolFilePath);
        } catch (error) {
          console.warn(`Failed to load symbol file for net ${net.name}:`, error);
          set((s) => ({
            nets: s.nets.map((n) =>
              n.id === net.id ? { ...n, symbolFilePath: null } : n
            ),
          }));
        }
      }
    }
  },

  // --- Plot ---

  addPlotSignal: (signal: PlotSignal) => {
    set((s) => {
      const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
      if (
        s.selectedPlotSignals.some(
          (sig) =>
            sig.channelId === signal.channelId &&
            sig.messageId === signal.messageId &&
            sig.signalName === signal.signalName
        )
      ) {
        return {};
      }
      const newPlotData = new Map(s.plotData);
      if (!newPlotData.has(key)) newPlotData.set(key, []);
      return {
        selectedPlotSignals: [...s.selectedPlotSignals, signal],
        plotData: newPlotData,
      };
    });
  },

  removePlotSignal: (signal: PlotSignal) => {
    set((s) => {
      const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
      const newPlotData = new Map(s.plotData);
      newPlotData.delete(key);
      return {
        selectedPlotSignals: s.selectedPlotSignals.filter(
          (sig) =>
            !(
              sig.channelId === signal.channelId &&
              sig.messageId === signal.messageId &&
              sig.signalName === signal.signalName
            )
        ),
        plotData: newPlotData,
      };
    });
  },

  clearPlotData: () => {
    set((s) => {
      const newPlotData = new Map<string, PlotDataPoint[]>();
      for (const signal of s.selectedPlotSignals) {
        const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
        newPlotData.set(key, []);
      }
      return { plotData: newPlotData };
    });
  },

  togglePlotPause: () => set((s) => ({ isPlotPaused: !s.isPlotPaused })),
  setPlotTimeWindow: (window: number) => set({ plotTimeWindow: window }),
  setPlotData: (data: Map<string, PlotDataPoint[]>) => set({ plotData: data }),
}));

// Counts come back from Rust as u64 -> JS number
type u64Number = number;

/** True when at least one net is connected. */
export const useAnyConnected = () =>
  useCanStore((s) => s.nets.some((n) => n.connectionStatus === "connected"));

/** Net lookup helpers (shallow-stable). */
export const useNets = () => useCanStore(useShallow((s) => s.nets));

export const useNetName = () => {
  const nets = useNets();
  return (netId: string) => nets.find((n) => n.id === netId)?.name ?? netId;
};

// Cleanup function for unmounting
export const cleanupCanStore = () => {
  unlistenBatch?.();
  unlistenBatch = null;
  unlistenStats?.();
  unlistenStats = null;
  unlistenInterfaces?.();
  unlistenInterfaces = null;
  unlistenChannelError?.();
  unlistenChannelError = null;
  if (txCountTimer) {
    clearInterval(txCountTimer);
    txCountTimer = null;
  }
};
