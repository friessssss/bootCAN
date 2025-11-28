// Project file type definitions for bootCAN project files

export interface ProjectChannel {
  id: string;
  name: string;
  interfaceId: string | null;
  bitrate: number;
  dbcFile: string | null; // File path, will be validated on load
}

export interface ProjectFilter {
  type: string;
  [key: string]: any;
}

export interface ProjectTransmitJob {
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
  // Note: backendJobId is not saved as it's runtime-only
}

export interface ProjectFile {
  version: string; // For future compatibility
  channels: ProjectChannel[];
  filters: ProjectFilter[];
  transmitJobs: ProjectTransmitJob[];
}

