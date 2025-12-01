import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

// CAN Message Types
export interface CanFrame {
  id: number;
  isExtended: boolean;
  isRemote: boolean;
  dlc: number;
  data: number[];
  timestamp: number;
  channel: string;
  direction: "rx" | "tx";
}

// Extended frame info for monitor view
export interface MonitorEntry {
  frame: CanFrame;
  count: number;
  cycleTime: number; // ms between messages
  lastTimestamp: number;
}

export interface BusStats {
  busLoad: number;
  txCount: number;
  rxCount: number;
  errorCount: number;
  txErrorCounter: number;
  rxErrorCounter: number;
}

export interface ChannelBusStats {
  channelId: string;
  busLoad: number;
}

export interface InterfaceInfo {
  id: string;
  name: string;
  type: "socketcan" | "pcan" | "virtual";
  available: boolean;
}

export interface TransmitJob {
  id: string;
  frame: CanFrame;
  intervalMs: number;
  enabled: boolean;
  backendJobId?: string; // ID returned by backend for cancellation
}

export interface PlotSignal {
  channelId: string;
  messageId: number;
  signalName: string;
}

export interface PlotDataPoint {
  time: number;
  value: number;
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

interface CanState {
  // Connection state
  connectionStatus: ConnectionStatus;
  selectedInterface: string | null;
  selectedBitrate: number;
  availableInterfaces: InterfaceInfo[];
  
  // Multi-channel state
  channels: Array<{ 
    id: string; 
    name: string;
    interfaceId: string | null;
    bitrate: number;
    dbcFile: string | null;
    connectionStatus: ConnectionStatus;
  }>;
  activeChannel: string | null;
  
  // Filter state
  filters: Array<{
    type: string;
    [key: string]: any;
  }>;

  // Message buffers - trace collects all, monitor shows latest per ID with metadata
  traceMessages: CanFrame[];
  monitorMessages: Map<string, MonitorEntry>; // key: `${id}-${direction}`
  maxMessages: number;
  isPaused: boolean;
  
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
  playbackCurrentIndex: number;
  
  // DBC state
  loadedDbcFiles: Map<string, string>; // channel_id -> file_path
  selectedMessage: CanFrame | null; // Currently selected message for signal inspection

  // Bus statistics (per channel)
  channelBusStats: Map<string, BusStats>; // channel_id -> BusStats

  // Transmit state
  transmitJobs: TransmitJob[];
  pendingTransmit: Partial<CanFrame>;

  // Filters
  idFilter: string;
  showRxOnly: boolean;
  showTxOnly: boolean;

  // View mode: "trace" shows all messages, "monitor" shows latest per ID
  viewMode: "trace" | "monitor";
  setViewMode: (mode: "trace" | "monitor") => void;

  // Plot state
  viewTab: "monitor" | "plot";
  selectedPlotSignals: PlotSignal[];
  plotData: Map<string, PlotDataPoint[]>; // key: `${channelId}-${messageId}-${signalName}`
  isPlotPaused: boolean;
  plotTimeWindow: number; // seconds
  plotMaxDataPoints: number;

  // Actions
  initializeBackend: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  setSelectedInterface: (id: string) => void;
  setSelectedBitrate: (bitrate: number) => void;
  sendMessage: (frame: Partial<CanFrame>) => Promise<void>;
  clearMessages: () => void;
  // Computed getter for current view's messages
  getDisplayMessages: () => MonitorEntry[];
  togglePause: () => void;
  setPendingTransmit: (frame: Partial<CanFrame>) => void;
  addTransmitJob: (job: Omit<TransmitJob, "id">) => void;
  updateTransmitJob: (id: string, job: Omit<TransmitJob, "id">) => Promise<void>;
  removeTransmitJob: (id: string) => Promise<void>;
  toggleTransmitJob: (id: string) => Promise<void>;
  setIdFilter: (filter: string) => void;
  toggleRecording: () => void;
  stopRecording: () => void;
  
  // Trace logging actions
  startLogging: (filePath: string, format: "csv" | "trc") => Promise<void>;
  stopLogging: () => Promise<void>;
  
  // Trace playback actions
  loadTrace: (filePath: string) => Promise<number>;
  startPlayback: () => Promise<void>;
  stopPlayback: () => Promise<void>;
  pausePlayback: () => Promise<void>;
  resumePlayback: () => Promise<void>;
  setPlaybackSpeed: (speed: number) => Promise<void>;
  
  // DBC actions
  loadDbc: (channelId: string, filePath: string) => Promise<void>;
  removeDbc: (channelId: string) => Promise<void>;
  setSelectedMessage: (message: CanFrame | null) => void;
  
  // Multi-channel actions
  addChannel: () => void;
  removeChannel: (id: string) => void;
  setActiveChannel: (id: string) => void;
  updateChannel: (id: string, updates: Partial<{ name: string; interfaceId: string | null; bitrate: number; dbcFile: string | null }>) => void;
  connectChannel: (id: string) => Promise<void>;
  disconnectChannel: (id: string) => Promise<void>;
  
  // Filter actions
  setFilters: (filters: Array<{ type: string; [key: string]: any }>) => void;
  
  // Project file actions
  saveProject: (filePath: string) => Promise<void>;
  loadProject: (filePath: string) => Promise<void>;
  
  // Plot actions
  setViewTab: (tab: "monitor" | "plot") => void;
  addPlotSignal: (signal: PlotSignal) => void;
  removePlotSignal: (signal: PlotSignal) => void;
  clearPlotData: () => void;
  togglePlotPause: () => void;
  setPlotTimeWindow: (window: number) => void;
  setPlotData: (data: Map<string, PlotDataPoint[]>) => void;
}

// Event listener cleanup
let unlistenMessage: UnlistenFn | null = null;
let unlistenStats: UnlistenFn | null = null;
let isInitialized = false;

export const useCanStore = create<CanState>((set, get) => ({
  // Initial state
  connectionStatus: "disconnected",
  selectedInterface: null,
  selectedBitrate: 500000,
  availableInterfaces: [],
  channels: [],
  activeChannel: null,
  filters: [],
  traceMessages: [],
  monitorMessages: new Map<string, MonitorEntry>(),
  maxMessages: 10000,
  isPaused: false,
  isRecording: false,
  recordingStartTime: null,
  isLogging: false,
  logFilePath: null,
  logFormat: "csv",
  playbackState: "stopped",
  playbackSpeed: 1.0,
  loadedTraceFile: null,
  playbackFrameCount: 0,
  playbackCurrentIndex: 0,
  loadedDbcFiles: new Map<string, string>(),
  selectedMessage: null,
  channelBusStats: new Map<string, BusStats>(),
  transmitJobs: [],
  pendingTransmit: {
    id: 0x100,
    isExtended: false,
    isRemote: false,
    dlc: 8,
    data: [0, 0, 0, 0, 0, 0, 0, 0],
  },
  idFilter: "",
  showRxOnly: false,
  showTxOnly: false,
  viewMode: "monitor",

  setViewMode: (mode: "trace" | "monitor") => set({ viewMode: mode }),

  // Plot state initialization
  viewTab: "monitor",
  selectedPlotSignals: [],
  plotData: new Map<string, PlotDataPoint[]>(),
  isPlotPaused: false,
  plotTimeWindow: -1, // -1 = "All", otherwise seconds
  plotMaxDataPoints: 5000,

  // Initialize backend and set up event listeners
  initializeBackend: async () => {
    // Prevent duplicate initialization (React StrictMode calls effects twice)
    if (isInitialized) {
      console.log("Backend already initialized, skipping...");
      return;
    }
    isInitialized = true;

    try {
      console.log("Initializing backend...");
      
      // Get available interfaces
      const interfaces = await invoke<InterfaceInfo[]>("get_interfaces");
      console.log("Available interfaces:", interfaces);
      set({ availableInterfaces: interfaces });

      // Select first available interface by default
      if (interfaces.length > 0) {
        set({ selectedInterface: interfaces[0].id });
      }

      // Set up event listeners for incoming messages
      console.log("Setting up can-message listener...");
      unlistenMessage = await listen<CanFrame>("can-message", async (event) => {
        const state = get();
        if (state.isPaused) return;

        const newFrame = event.payload;
        
        // Check if this is from trace playback (has loadedTraceFile and playback is active)
        const isTracePlayback = state.loadedTraceFile !== null && 
                                (state.playbackState === "playing" || state.playbackState === "paused");
        
        // Include channel in key so same ID on different channels are separate
        const monitorKey = `${newFrame.channel}-${newFrame.id}-${newFrame.direction}`;
        
        set((s) => {
          // Only update monitor messages for live CAN data, not trace playback
          let newMonitorMessages = s.monitorMessages;
          if (!isTracePlayback) {
            newMonitorMessages = new Map(s.monitorMessages);
            const existing = newMonitorMessages.get(monitorKey);
            
            let cycleTime = 0;
            let count = 1;
            
            if (existing) {
              count = existing.count + 1;
              // Calculate cycle time in ms
              cycleTime = (newFrame.timestamp - existing.lastTimestamp) * 1000;
            }
            
            newMonitorMessages.set(monitorKey, {
              frame: newFrame,
              count,
              cycleTime,
              lastTimestamp: newFrame.timestamp,
            });
          }
          
          // Only append to trace if recording is active (live data only, not trace playback)
          let newTraceMessages = s.traceMessages;
          let newRecordingStartTime = s.recordingStartTime;
          
          if (s.isRecording && !isTracePlayback) {
            // Live recording: If this is the first message after starting recording, use its timestamp as reference
            if (newRecordingStartTime === null) {
              newRecordingStartTime = newFrame.timestamp;
            }
            // Calculate relative timestamp
            const relativeTimestamp = newFrame.timestamp - newRecordingStartTime;
            const frameWithRelativeTime = { ...newFrame, timestamp: relativeTimestamp };
            newTraceMessages = [...s.traceMessages, frameWithRelativeTime].slice(-s.maxMessages);
          }
          // Note: Trace playback messages are already loaded into traceMessages, so we don't add them again
          
          return {
            traceMessages: newTraceMessages,
            monitorMessages: newMonitorMessages,
            recordingStartTime: newRecordingStartTime,
          };
        });

        // Decode signals for plot if not paused and signals are selected
        // Skip real-time updates during trace playback (data is loaded all at once, not incrementally)
        const currentState = get();
        
        if (!currentState.isPlotPaused && currentState.selectedPlotSignals.length > 0 && !isTracePlayback) {
          // Find signals that match this message
          const matchingSignals = currentState.selectedPlotSignals.filter(
            (sig) => sig.channelId === newFrame.channel && sig.messageId === newFrame.id
          );

          if (matchingSignals.length > 0) {
            if (!currentState.loadedDbcFiles.has(newFrame.channel)) {
              // No DBC loaded for this channel, skip
            } else {
              // Decode all signals for this message
              invoke<Array<{ name: string; physicalValue: number }>>("decode_message", {
                channelId: newFrame.channel,
                messageId: newFrame.id,
                data: newFrame.data,
              })
                .then((decodedSignals) => {
                  const state = get();
                  const newPlotData = new Map(state.plotData);
                  const currentTime = newFrame.timestamp;
                  const timeWindow = state.plotTimeWindow;
                  const maxPoints = state.plotMaxDataPoints;

                  // Update data for each matching signal
                  for (const signal of matchingSignals) {
                    const decoded = decodedSignals.find((s) => s.name === signal.signalName);
                    if (decoded) {
                      const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
                      let dataPoints = newPlotData.get(key) || [];

                      // Add new data point
                      dataPoints.push({ time: currentTime, value: decoded.physicalValue });

                      // Remove points outside time window
                      const cutoffTime = currentTime - timeWindow;
                      dataPoints = dataPoints.filter((pt) => pt.time >= cutoffTime);

                      // Trim to max points (keep most recent)
                      if (dataPoints.length > maxPoints) {
                        dataPoints = dataPoints.slice(-maxPoints);
                      }

                      newPlotData.set(key, dataPoints);
                    }
                    // Signal not found in decoded signals, skip
                  }

                  set({ plotData: newPlotData });
                })
                .catch((_error) => {
                  // Failed to decode signals, skip this message
                });
            }
          } else {
            // Message doesn't match any selected signals, skip
          }
        }
      });
      console.log("can-message listener set up");

      // Set up event listeners for bus statistics
      unlistenStats = await listen<{ channelId: string; busLoad: number; txCount: number; rxCount: number; errorCount: number; txErrorCounter: number; rxErrorCounter: number }>("bus-stats", (event) => {
        const stats = event.payload;
        set((s) => {
          const newStats = new Map(s.channelBusStats);
          newStats.set(stats.channelId, {
            busLoad: stats.busLoad,
            txCount: stats.txCount,
            rxCount: stats.rxCount,
            errorCount: stats.errorCount,
            txErrorCounter: stats.txErrorCounter,
            rxErrorCounter: stats.rxErrorCounter,
          });
          return { channelBusStats: newStats };
        });
      });
      
      console.log("Backend initialized successfully");
    } catch (error) {
      console.error("Failed to initialize backend:", error);
      isInitialized = false; // Allow retry on error
    }
  },

  // Connect to selected interface
  connect: async () => {
    const { selectedInterface, selectedBitrate } = get();
    if (!selectedInterface) return;

    set({ connectionStatus: "connecting" });

    try {
      await invoke("connect", {
        interfaceId: selectedInterface,
        bitrate: selectedBitrate,
      });
      set({ connectionStatus: "connected" });
    } catch (error) {
      console.error("Failed to connect:", error);
      set({ connectionStatus: "error" });
    }
  },

  // Disconnect from interface
  disconnect: async () => {
    try {
      await invoke("disconnect");
      set({ connectionStatus: "disconnected" });
    } catch (error) {
      console.error("Failed to disconnect:", error);
    }
  },

  setSelectedInterface: (id: string) => set({ selectedInterface: id }),
  setSelectedBitrate: (bitrate: number) => set({ selectedBitrate: bitrate }),

  // Send a CAN message
  sendMessage: async (frame: Partial<CanFrame>) => {
    const { channels } = get();
    // Check if the specified channel (or any channel) is connected
    const channelId = frame.channel;
    const channel = channelId ? channels.find(c => c.id === channelId) : null;
    
    if (channelId && channel && channel.connectionStatus !== "connected") {
      console.log("Channel not connected, skipping send");
      return;
    }
    
    // If no channel specified, check if any channel is connected
    if (!channelId) {
      const hasConnected = channels.some(c => c.connectionStatus === "connected");
      if (!hasConnected) {
        console.log("No connected channels, skipping send");
        return;
      }
    }

    try {
      console.log("Invoking send_message command...");
      await invoke("send_message", { frame });
      console.log("send_message command completed");
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  },

  clearMessages: () => set({ 
    traceMessages: [], 
    monitorMessages: new Map<string, MonitorEntry>() 
  }),
  
  getDisplayMessages: () => {
    const state = get();
    if (state.viewMode === "monitor") {
      // Return monitor entries sorted by ID
      // Monitor mode doesn't use traceMessages, so we can skip that dependency
      return Array.from(state.monitorMessages.values()).sort((a, b) => a.frame.id - b.frame.id);
    } else {
      // Return all trace messages wrapped as MonitorEntry for consistent interface
      // Limit to maxMessages to prevent performance issues with very large traces
      const maxTraceMessages = state.maxMessages;
      const messagesToShow = state.traceMessages.length > maxTraceMessages
        ? state.traceMessages.slice(-maxTraceMessages)
        : state.traceMessages;
      
      return messagesToShow.map(frame => ({
        frame,
        count: 0,
        cycleTime: 0,
        lastTimestamp: frame.timestamp,
      }));
    }
  },
  togglePause: () => set((s) => ({ isPaused: !s.isPaused })),
  setPendingTransmit: (frame: Partial<CanFrame>) =>
    set((s) => ({
      pendingTransmit: { ...s.pendingTransmit, ...frame },
    })),

  addTransmitJob: (job: Omit<TransmitJob, "id">) => {
    const id = crypto.randomUUID();
    set((s) => ({
      transmitJobs: [...s.transmitJobs, { ...job, id }],
    }));
  },

  updateTransmitJob: async (id: string, job: Omit<TransmitJob, "id">) => {
    const existingJob = get().transmitJobs.find((j) => j.id === id);
    if (!existingJob) return;

    // If the job is currently enabled, stop it first
    if (existingJob.enabled && existingJob.backendJobId) {
      try {
        await invoke("stop_periodic_transmit", { jobId: existingJob.backendJobId });
      } catch (e) {
        console.error("Failed to stop periodic transmit for update:", e);
      }
    }

    // Update the job
    set((s) => ({
      transmitJobs: s.transmitJobs.map((j) =>
        j.id === id ? { ...job, id, enabled: false, backendJobId: undefined } : j
      ),
    }));
  },

  removeTransmitJob: async (id: string) => {
    // Stop the job on backend if running
    const job = get().transmitJobs.find((j) => j.id === id);
    if (job?.enabled && job.backendJobId) {
      try {
        await invoke("stop_periodic_transmit", { jobId: job.backendJobId });
      } catch (e) {
        console.error("Failed to stop periodic transmit:", e);
      }
    }
    set((s) => ({
      transmitJobs: s.transmitJobs.filter((j) => j.id !== id),
    }));
  },

  toggleTransmitJob: async (id: string) => {
    const job = get().transmitJobs.find((j) => j.id === id);
    if (!job) return;

    const newEnabled = !job.enabled;
    
    try {
      if (newEnabled) {
        // Start periodic transmit on backend
        const frame = {
          id: job.frame.id,
          isExtended: job.frame.isExtended,
          isRemote: job.frame.isRemote,
          dlc: job.frame.dlc,
          data: job.frame.data,
          channel: job.frame.channel || undefined,
        };
        // Backend returns the actual job ID we need to use for stopping
        const backendJobId = await invoke<string>("start_periodic_transmit", { 
          frame, 
          intervalMs: job.intervalMs 
        });
        
        // Update the job with the backend ID and enabled state
        set((s) => ({
          transmitJobs: s.transmitJobs.map((j) =>
            j.id === id ? { ...j, enabled: true, backendJobId } : j
          ),
        }));
      } else {
        // Stop periodic transmit using the backend job ID
        if (job.backendJobId) {
          await invoke("stop_periodic_transmit", { jobId: job.backendJobId });
        }
        
        set((s) => ({
          transmitJobs: s.transmitJobs.map((j) =>
            j.id === id ? { ...j, enabled: false, backendJobId: undefined } : j
          ),
        }));
      }
    } catch (e) {
      console.error("Failed to toggle periodic transmit:", e);
    }
  },

  setIdFilter: (filter: string) => set({ idFilter: filter }),
  
  toggleRecording: () => {
    const state = get();
    if (state.isRecording) {
      // Stop recording
      set({ isRecording: false, recordingStartTime: null });
    } else {
      // Start recording - clear existing trace
      // recordingStartTime will be set to the first message's timestamp when it arrives
      set({ 
        isRecording: true, 
        recordingStartTime: null,
        traceMessages: [] // Clear existing trace when starting new recording
      });
    }
  },
  
  stopRecording: () => set({ isRecording: false, recordingStartTime: null }),
  
  // Trace logging actions
  startLogging: async (filePath: string, format: "csv" | "trc") => {
    try {
      await invoke("start_logging", { filePath, format });
      set({ isLogging: true, logFilePath: filePath, logFormat: format });
    } catch (error) {
      console.error("Failed to start logging:", error);
      throw error;
    }
  },
  
  stopLogging: async () => {
    try {
      await invoke("stop_logging");
      set({ isLogging: false, logFilePath: null });
    } catch (error) {
      console.error("Failed to stop logging:", error);
      throw error;
    }
  },
  
  // Trace playback actions
  loadTrace: async (filePath: string) => {
    try {
      // Build bus-to-channel mapping based on channel numbers
      // Extract channel number from channel name (e.g., "Channel 3" -> bus 3)
      // Use channel NAMES (not IDs) for the mapping as requested
      const state = get();
      const busToChannelNameMap = new Map<number, string>();
      const channelNameToIdMap = new Map<string, string>();
      
      for (const channel of state.channels) {
        // Store name -> ID mapping for backend resolution
        channelNameToIdMap.set(channel.name, channel.id);
        
        // Extract number from channel name (e.g., "Channel 3" -> 3)
        const match = channel.name.match(/\d+/);
        if (match) {
          const busNum = parseInt(match[0], 10);
          if (busNum > 0 && busNum <= 255) {
            // Map bus number to channel NAME (not ID)
            busToChannelNameMap.set(busNum, channel.name);
          }
        }
      }
      
      // Convert Maps to objects for Tauri
      const busToNameObj: Record<string, string> = {};
      busToChannelNameMap.forEach((channelName, busNum) => {
        busToNameObj[busNum.toString()] = channelName;
      });
      
      const nameToIdObj: Record<string, string> = {};
      channelNameToIdMap.forEach((channelId, channelName) => {
        nameToIdObj[channelName] = channelId;
      });
      
      let count: number;
      try {
        count = await invoke<number>("load_trace", { 
          filePath,
          busToChannelMap: Object.keys(busToNameObj).length > 0 ? busToNameObj : undefined,
          channelNameToIdMap: Object.keys(nameToIdObj).length > 0 ? nameToIdObj : undefined
        });
        // Trace loaded
      } catch (error) {
        console.error("Failed to invoke load_trace:", error);
        throw error;
      }
      
      if (count === undefined || count === null || isNaN(count)) {
        throw new Error(`load_trace returned invalid count: ${count}`);
      }
      
      // Load all frames directly into traceMessages (fast, bypasses event listener)
      const allFrames = await invoke<CanFrame[]>("get_trace_frames");
      
      // Calculate relative timestamps (first frame = 0)
      const firstTimestamp = allFrames.length > 0 ? allFrames[0].timestamp : 0;
      const traceFrames = allFrames.map(frame => ({
        ...frame,
        timestamp: frame.timestamp - firstTimestamp
      }));
      
      set({ 
        loadedTraceFile: filePath, 
        playbackFrameCount: count, 
        playbackCurrentIndex: 0,
        traceMessages: traceFrames, // Load directly into trace tab, not monitor
      });
      
      return count;
    } catch (error) {
      console.error("Failed to load trace:", error);
      throw error;
    }
  },
  
  startPlayback: async () => {
    try {
      await invoke("start_playback");
      set({ playbackState: "playing" });
    } catch (error) {
      console.error("Failed to start playback:", error);
      throw error;
    }
  },
  
  stopPlayback: async () => {
    try {
      await invoke("stop_playback");
      set({ playbackState: "stopped", playbackCurrentIndex: 0 });
    } catch (error) {
      console.error("Failed to stop playback:", error);
      throw error;
    }
  },
  
  pausePlayback: async () => {
    try {
      await invoke("pause_playback");
      set({ playbackState: "paused" });
    } catch (error) {
      console.error("Failed to pause playback:", error);
      throw error;
    }
  },
  
  resumePlayback: async () => {
    try {
      await invoke("resume_playback");
      set({ playbackState: "playing" });
    } catch (error) {
      console.error("Failed to resume playback:", error);
      throw error;
    }
  },
  
  setPlaybackSpeed: async (speed: number) => {
    try {
      await invoke("set_playback_speed", { speed });
      set({ playbackSpeed: speed });
    } catch (error) {
      console.error("Failed to set playback speed:", error);
      throw error;
    }
  },
  
  // DBC actions
  loadDbc: async (channelId: string, filePath: string) => {
    try {
      await invoke("load_dbc", { channelId, filePath });
      set((s) => {
        const newMap = new Map(s.loadedDbcFiles);
        newMap.set(channelId, filePath);
        // Also update the channel's dbcFile field for consistency
        const updatedChannels = s.channels.map(ch =>
          ch.id === channelId ? { ...ch, dbcFile: filePath } : ch
        );
        return { 
          loadedDbcFiles: newMap,
          channels: updatedChannels,
        };
      });
    } catch (error) {
      console.error("Failed to load DBC:", error);
      throw error;
    }
  },
  
  removeDbc: async (channelId: string) => {
    try {
      // Note: Backend doesn't have remove_dbc command yet, but we can clear from frontend
      set((s) => {
        const newMap = new Map(s.loadedDbcFiles);
        newMap.delete(channelId);
        // Also clear the channel's dbcFile field
        const updatedChannels = s.channels.map(ch =>
          ch.id === channelId ? { ...ch, dbcFile: null } : ch
        );
        return { 
          loadedDbcFiles: newMap,
          channels: updatedChannels,
        };
      });
    } catch (error) {
      console.error("Failed to remove DBC:", error);
      throw error;
    }
  },
  
  setSelectedMessage: (message) => set({ selectedMessage: message }),
  
  // Multi-channel actions
  addChannel: () => {
    const id = `channel_${Date.now()}`;
    const name = `Channel ${get().channels.length + 1}`;
    set((s) => ({
      channels: [...s.channels, { 
        id, 
        name,
        interfaceId: null,
        bitrate: 500000,
        dbcFile: null,
        connectionStatus: "disconnected",
      }],
      activeChannel: s.activeChannel || id,
    }));
  },
  
  removeChannel: async (id: string) => {
    const channel = get().channels.find((c) => c.id === id);
    if (channel && channel.connectionStatus === "connected") {
      await get().disconnectChannel(id);
    }
    set((s) => {
      const newChannels = s.channels.filter((c) => c.id !== id);
      const newActiveChannel =
        s.activeChannel === id
          ? newChannels.length > 0
            ? newChannels[0].id
            : null
          : s.activeChannel;
      return {
        channels: newChannels,
        activeChannel: newActiveChannel,
      };
    });
  },
  
  setActiveChannel: (id) => set({ activeChannel: id }),
  
  updateChannel: (id: string, updates) => {
    set((s) => ({
      channels: s.channels.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    }));
  },
  
  connectChannel: async (id: string) => {
    const channel = get().channels.find((c) => c.id === id);
    if (!channel || !channel.interfaceId) return;
    
    set((s) => ({
      channels: s.channels.map((c) =>
        c.id === id ? { ...c, connectionStatus: "connecting" } : c
      ),
    }));
    
    try {
      await invoke("connect_channel", {
        channelId: id,
        interfaceId: channel.interfaceId,
        bitrate: channel.bitrate,
      });
      set((s) => ({
        channels: s.channels.map((c) =>
          c.id === id ? { ...c, connectionStatus: "connected" } : c
        ),
      }));
    } catch (error) {
      console.error("Failed to connect channel:", error);
      set((s) => ({
        channels: s.channels.map((c) =>
          c.id === id ? { ...c, connectionStatus: "error" } : c
        ),
      }));
    }
  },
  
  disconnectChannel: async (id: string) => {
    try {
      await invoke("disconnect_channel", { channelId: id });
      set((s) => ({
        channels: s.channels.map((c) =>
          c.id === id ? { ...c, connectionStatus: "disconnected" } : c
        ),
      }));
    } catch (error) {
      console.error("Failed to disconnect channel:", error);
      set((s) => ({
        channels: s.channels.map((c) =>
          c.id === id ? { ...c, connectionStatus: "error" } : c
        ),
      }));
    }
  },
  
  // Filter actions
  setFilters: (filters) => set({ filters }),
  
  // Project file actions
  saveProject: async (filePath: string) => {
    const state = get();
    
    // Convert channels to project format
    // Use loadedDbcFiles Map to get the actual DBC file path
    const projectChannels = state.channels.map(ch => ({
      id: ch.id,
      name: ch.name,
      interfaceId: ch.interfaceId,
      bitrate: ch.bitrate,
      dbcFile: state.loadedDbcFiles.get(ch.id) || ch.dbcFile || null,
    }));
    
    // Convert filters to project format
    const projectFilters = state.filters.map(f => ({ data: f }));
    
    // Convert transmit jobs to project format (exclude backendJobId)
    const projectTransmitJobs = state.transmitJobs.map(job => ({
      id: job.id,
      frame: {
        id: job.frame.id,
        isExtended: job.frame.isExtended,
        isRemote: job.frame.isRemote,
        dlc: job.frame.dlc,
        data: job.frame.data,
        channel: job.frame.channel || undefined,
      },
      intervalMs: job.intervalMs,
      enabled: false, // Always save as disabled
    }));
    
    try {
      await invoke("save_project", {
        filePath,
        channels: projectChannels,
        filters: projectFilters,
        transmitJobs: projectTransmitJobs,
      });
      console.log("Project saved successfully");
    } catch (error) {
      console.error("Failed to save project:", error);
      throw error;
    }
  },
  
  loadProject: async (filePath: string) => {
    try {
      const project = await invoke<{
        version: string;
        channels: Array<{
          id: string;
          name: string;
          interfaceId: string | null;
          bitrate: number;
          dbcFile: string | null;
        }>;
        filters: Array<{ data: any }>;
        transmitJobs: Array<{
          id: string;
          frame: {
            id: number;
            isExtended: boolean;
            isRemote: boolean;
            dlc: number;
            data: number[];
            channel?: string;
          };
          intervalMs: number;
          enabled: boolean;
        }>;
      }>("load_project", { filePath });
      
      // Restore channels
      const restoredChannels = project.channels.map(ch => ({
        id: ch.id,
        name: ch.name,
        interfaceId: ch.interfaceId,
        bitrate: ch.bitrate,
        dbcFile: ch.dbcFile,
        connectionStatus: "disconnected" as ConnectionStatus,
      }));
      
      // Restore filters
      const restoredFilters = project.filters.map(f => f.data);
      
      // Restore transmit jobs (all disabled on load)
      const restoredTransmitJobs = project.transmitJobs.map(job => ({
        id: job.id,
        frame: {
          id: job.frame.id,
          isExtended: job.frame.isExtended,
          isRemote: job.frame.isRemote,
          dlc: job.frame.dlc,
          data: job.frame.data,
          timestamp: 0,
          channel: job.frame.channel || "",
          direction: "tx" as const,
        },
        intervalMs: job.intervalMs,
        enabled: false,
        backendJobId: undefined,
      }));
      
      // Restore loadedDbcFiles Map from restored channels
      const restoredDbcFiles = new Map<string, string>();
      for (const channel of restoredChannels) {
        if (channel.dbcFile) {
          restoredDbcFiles.set(channel.id, channel.dbcFile);
        }
      }
      
      // Update state first
      set({
        channels: restoredChannels,
        filters: restoredFilters,
        transmitJobs: restoredTransmitJobs,
        activeChannel: restoredChannels.length > 0 ? restoredChannels[0].id : null,
        loadedDbcFiles: restoredDbcFiles,
      });
      
      // Load DBC files if they exist (this will also update the backend)
      for (const channel of restoredChannels) {
        if (channel.dbcFile) {
          try {
            await get().loadDbc(channel.id, channel.dbcFile);
          } catch (error) {
            console.warn(`Failed to load DBC file ${channel.dbcFile} for channel ${channel.id}:`, error);
            // Remove from loadedDbcFiles if loading failed
            set((s) => {
              const newMap = new Map(s.loadedDbcFiles);
              newMap.delete(channel.id);
              return { loadedDbcFiles: newMap };
            });
            // Continue loading even if DBC fails
          }
        }
      }
      
      console.log("Project loaded successfully");
    } catch (error) {
      console.error("Failed to load project:", error);
      throw error;
    }
  },

  // Plot actions
  setViewTab: (tab: "monitor" | "plot") => set({ viewTab: tab }),

  addPlotSignal: (signal: PlotSignal) => {
    set((s) => {
      const key = `${signal.channelId}-${signal.messageId}-${signal.signalName}`;
      // Check if already exists
      if (s.selectedPlotSignals.some(
        (sig) => sig.channelId === signal.channelId &&
                 sig.messageId === signal.messageId &&
                 sig.signalName === signal.signalName
      )) {
        return {};
      }
      // Initialize empty data array for this signal
      const newPlotData = new Map(s.plotData);
      if (!newPlotData.has(key)) {
        newPlotData.set(key, []);
      }
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
          (sig) => !(sig.channelId === signal.channelId &&
                     sig.messageId === signal.messageId &&
                     sig.signalName === signal.signalName)
        ),
        plotData: newPlotData,
      };
    });
  },

  clearPlotData: () => {
    set((s) => {
      const newPlotData = new Map<string, PlotDataPoint[]>();
      // Keep the structure but clear all data
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

// Cleanup function for unmounting
export const cleanupCanStore = () => {
  if (unlistenMessage) {
    unlistenMessage();
    unlistenMessage = null;
  }
  if (unlistenStats) {
    unlistenStats();
    unlistenStats = null;
  }
};

