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

  // Message buffers - trace collects all, monitor shows latest per ID with metadata
  traceMessages: CanFrame[];
  monitorMessages: Map<string, MonitorEntry>; // key: `${id}-${direction}`
  maxMessages: number;
  isPaused: boolean;
  
  // Recording state for trace
  isRecording: boolean;
  recordingStartTime: number | null;

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
  removeTransmitJob: (id: string) => Promise<void>;
  toggleTransmitJob: (id: string) => Promise<void>;
  setIdFilter: (filter: string) => void;
  toggleRecording: () => void;
  stopRecording: () => void;
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
  traceMessages: [],
  monitorMessages: new Map<string, MonitorEntry>(),
  maxMessages: 10000,
  isPaused: false,
  isRecording: false,
  recordingStartTime: null,
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
        const monitorKey = `${newFrame.id}-${newFrame.direction}`;
        
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
    const { connectionStatus } = get();
    console.log("sendMessage called, status:", connectionStatus, "frame:", frame);
    if (connectionStatus !== "connected") {
      console.log("Not connected, skipping send");
      return;
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

