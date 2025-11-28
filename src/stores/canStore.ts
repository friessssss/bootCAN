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

  // Bus statistics
  busStats: BusStats;

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
  loadTrace: (filePath: string) => Promise<void>;
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
  busStats: {
    busLoad: 0,
    txCount: 0,
    rxCount: 0,
    errorCount: 0,
    txErrorCounter: 0,
    rxErrorCounter: 0,
  },
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
      unlistenMessage = await listen<CanFrame>("can-message", (event) => {
        const state = get();
        if (state.isPaused) return;

        const newFrame = event.payload;
        // Include channel in key so same ID on different channels are separate
        const monitorKey = `${newFrame.channel}-${newFrame.id}-${newFrame.direction}`;
        
        // Always update both buffers
        set((s) => {
          // Update monitor map with count and cycle time
          const newMonitorMessages = new Map(s.monitorMessages);
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
          
          // Only append to trace if recording is active
          let newTraceMessages = s.traceMessages;
          let newRecordingStartTime = s.recordingStartTime;
          
          if (s.isRecording) {
            // If this is the first message after starting recording, use its timestamp as reference
            if (newRecordingStartTime === null) {
              newRecordingStartTime = newFrame.timestamp;
            }
            // Calculate relative timestamp
            const relativeTimestamp = newFrame.timestamp - newRecordingStartTime;
            const frameWithRelativeTime = { ...newFrame, timestamp: relativeTimestamp };
            newTraceMessages = [...s.traceMessages, frameWithRelativeTime].slice(-s.maxMessages);
          }
          
          return {
            traceMessages: newTraceMessages,
            monitorMessages: newMonitorMessages,
            recordingStartTime: newRecordingStartTime,
          };
        });
      });
      console.log("can-message listener set up");

      // Set up event listeners for bus statistics
      unlistenStats = await listen<BusStats>("bus-stats", (event) => {
        set({ busStats: event.payload });
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
      return Array.from(state.monitorMessages.values()).sort((a, b) => a.frame.id - b.frame.id);
    } else {
      // Return all trace messages wrapped as MonitorEntry for consistent interface
      return state.traceMessages.map(frame => ({
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
      const count = await invoke<number>("load_trace", { filePath });
      set({ loadedTraceFile: filePath, playbackFrameCount: count, playbackCurrentIndex: 0 });
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
        return { loadedDbcFiles: newMap };
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
        return { loadedDbcFiles: newMap };
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

