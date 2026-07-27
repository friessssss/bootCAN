// Shared domain types for the bootCAN frontend.

export interface CanFrame {
  id: number;
  isExtended: boolean;
  isRemote: boolean;
  dlc: number;
  data: number[];
  timestamp: number;
  channel: string; // net id the frame belongs to
  direction: "rx" | "tx";
}

/** Aggregated per-ID entry for the receive (monitor) list. */
export interface MonitorEntry {
  frame: CanFrame;
  count: number;
  /** Smoothed cycle time in ms (EMA over frame-timestamp deltas). */
  cycleTime: number;
  lastTimestamp: number;
  /** Wall-clock ms (performance.now) each data byte last changed; for highlighting. */
  changedAt: number[];
}

export type BusStateValue = "active" | "warning" | "passive" | "busOff" | "unknown";

export interface BusStats {
  busLoad: number;
  txCount: number;
  rxCount: number;
  errorCount: number;
  txErrorCounter: number;
  rxErrorCounter: number;
  busState: BusStateValue;
}

export interface InterfaceInfo {
  id: string;
  name: string;
  type: "socketcan" | "pcan" | "virtual";
  available: boolean;
  /** "available" | "occupied" — only set for hardware interfaces. */
  condition?: string;
  deviceId?: number;
  firmware?: string;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * A Net is a named bus definition (PCAN-style): name + bitrate + symbol file.
 * It exists independently of hardware; `assignedDeviceId` binds it to a
 * detected interface when one is plugged in.
 */
export interface Net {
  id: string;
  name: string;
  bitrate: number;
  assignedDeviceId: string | null;
  symbolFilePath: string | null;
  comment?: string;
  connectionStatus: ConnectionStatus;
}

/** A row in the PCX7-style transmit list. */
export interface TransmitRow {
  id: string;
  /** Display name — symbolic message name or user text. */
  name: string;
  comment: string;
  netId: string | null;
  canId: number;
  isExtended: boolean;
  isRemote: boolean;
  dlc: number;
  data: number[];
  /** Cycle time in ms; 0 = manual-only row. */
  cycleMs: number;
  /** Cyclic sending paused (rows start paused; manual trigger always works). */
  paused: boolean;
  /** Total frames sent (cyclic backend count + manual sends). */
  count: number;
  /** Manual sends counted locally; added to the backend cyclic count. */
  manualCount: number;
  /** Backend job id while the cyclic job is running. */
  backendJobId?: string;
  /** Last signal-editor values (physical), for reopening the editor. */
  signalValues?: Record<string, number>;
}

export interface DecodedSignal {
  name: string;
  rawValue: number;
  physicalValue: number;
  unit: string;
  valueName: string | null;
}

/** Message definition subset returned by get_message_info / get_message_by_name. */
export interface MessageDef {
  id: number;
  name: string;
  dlc: number;
  signals: SignalDef[];
  comment: string | null;
}

export interface SignalDef {
  name: string;
  start_bit: number;
  length: number;
  value_type: "Unsigned" | "Signed" | "Float" | "Double";
  factor: number;
  offset: number;
  minimum: number | null;
  maximum: number | null;
  unit: string;
  comment: string | null;
  value_table: string | null;
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

export type SortKey = "name" | "id" | "channel" | "direction" | "dlc" | "cycleTime" | "count" | "timestamp";
export type SortDir = "asc" | "desc";

export interface MonitorSort {
  key: SortKey;
  dir: SortDir;
}
