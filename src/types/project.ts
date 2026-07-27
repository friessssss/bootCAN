// bootCAN project file schema (version 2.0).
//
// This is the single source of truth for the shapes exchanged with the
// backend's save_project / load_project commands. The backend migrates
// version 1.0 files (channels/transmitJobs) to this shape on load.

export interface ProjectNet {
  id: string;
  name: string;
  bitrate: number;
  /** Detected interface id this net was last bound to (kept even if unplugged). */
  assignedDeviceId: string | null;
  symbolFilePath: string | null;
  comment: string | null;
}

export interface ProjectFilter {
  data: any;
}

export interface ProjectTransmitRow {
  id: string;
  name: string;
  comment: string;
  netId: string | null;
  canId: number;
  isExtended: boolean;
  isRemote: boolean;
  dlc: number;
  data: number[];
  /** Cycle time in ms; 0 = manual-only. Rows always load paused. */
  cycleMs: number;
  signalValues: Record<string, number> | null;
}

export interface ProjectFile {
  version: string;
  nets: ProjectNet[];
  filters: ProjectFilter[];
  transmitRows: ProjectTransmitRow[];
}
