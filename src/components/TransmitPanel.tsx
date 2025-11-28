import { useState, useEffect } from "react";
import { useCanStore } from "../stores/canStore";
import {
  PaperAirplaneIcon,
  PlusIcon,
  TrashIcon,
  PlayIcon,
  PauseIcon,
  PencilIcon,
} from "./icons";

export function TransmitPanel() {
  const {
    channels,
    activeChannel,
    pendingTransmit,
    setPendingTransmit,
    sendMessage,
    transmitJobs,
    addTransmitJob,
    updateTransmitJob,
    removeTransmitJob,
    toggleTransmitJob,
  } = useCanStore();

  const [intervalMs, setIntervalMs] = useState(100);
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  // Local state for data byte inputs to allow free typing
  const [dataInputs, setDataInputs] = useState<string[]>(Array(8).fill("00"));
  
  // Get connected channels
  const connectedChannels = channels.filter(c => c.connectionStatus === "connected");
  const hasConnectedChannels = connectedChannels.length > 0;

  // Sync dataInputs with pendingTransmit.data when it changes externally (e.g., when editing a job)
  useEffect(() => {
    if (pendingTransmit.data && pendingTransmit.data.length === 8) {
      const formatted = pendingTransmit.data.map(b => b.toString(16).toUpperCase().padStart(2, "0"));
      setDataInputs(formatted);
    }
  }, [pendingTransmit.id, editingJobId]); // Sync when ID changes or when starting to edit

  const handleIdChange = (value: string) => {
    const parsed = parseInt(value.replace("0x", ""), 16);
    if (!isNaN(parsed)) {
      setPendingTransmit({ id: parsed });
    }
  };

  const handleDlcChange = (value: number) => {
    const dlc = Math.max(0, Math.min(8, value));
    setPendingTransmit({ dlc });
  };

  const handleDataChange = (index: number, value: string) => {
    // Remove any non-hex characters and limit to 2 characters
    const cleanValue = value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 2);
    
    // Update local input state immediately for responsive typing
    const newInputs = [...dataInputs];
    newInputs[index] = cleanValue || "0";
    setDataInputs(newInputs);
    
    // Parse and update the actual data array
    const parsed = parseInt(cleanValue || "0", 16);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 255) {
      const currentData = pendingTransmit.data || [0, 0, 0, 0, 0, 0, 0, 0];
      const newData = [...currentData];
      newData[index] = parsed;
      setPendingTransmit({ data: newData });
    }
  };

  const handleDataBlur = (index: number) => {
    // Format the value on blur to ensure it's always 2 digits
    const currentValue = dataInputs[index] || "0";
    const parsed = parseInt(currentValue, 16);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 255) {
      const formatted = parsed.toString(16).toUpperCase().padStart(2, "0");
      const newInputs = [...dataInputs];
      newInputs[index] = formatted;
      setDataInputs(newInputs);
    }
  };

  const handleSend = () => {
    if (!hasConnectedChannels) return;
    
    // Send to selected channels, or active channel if none selected, or first connected channel
    const channelsToSend = selectedChannels.length > 0 
      ? selectedChannels 
      : (activeChannel ? [activeChannel] : (connectedChannels.length > 0 ? [connectedChannels[0].id] : []));
    
    if (channelsToSend.length === 0) return;
    
    channelsToSend.forEach(channelId => {
      sendMessage({
        id: pendingTransmit.id,
        isExtended: pendingTransmit.isExtended,
        isRemote: pendingTransmit.isRemote,
        dlc: pendingTransmit.dlc,
        data: pendingTransmit.data,
        channel: channelId,
      });
    });
  };

  const handleAddPeriodic = () => {
    if (!hasConnectedChannels) return;
    
    // Use selected channels, or active channel, or first connected channel
    const channelId = selectedChannels.length > 0 
      ? selectedChannels[0] 
      : (activeChannel || connectedChannels[0]?.id || "");
    
    if (!channelId) return;
    
    const jobData = {
      frame: {
        id: pendingTransmit.id || 0x100,
        isExtended: pendingTransmit.isExtended || false,
        isRemote: pendingTransmit.isRemote || false,
        dlc: pendingTransmit.dlc || 8,
        data: pendingTransmit.data || [0, 0, 0, 0, 0, 0, 0, 0],
        timestamp: 0,
        channel: channelId,
        direction: "tx",
      },
      intervalMs,
      enabled: false,
    };

    if (editingJobId) {
      // Update existing job
      updateTransmitJob(editingJobId, jobData);
      setEditingJobId(null);
      // Clear the form
      setPendingTransmit({
        id: 0x100,
        isExtended: false,
        isRemote: false,
        dlc: 8,
        data: [0, 0, 0, 0, 0, 0, 0, 0],
      });
      setDataInputs(Array(8).fill("00"));
      setIntervalMs(100);
    } else {
      // Add new job
      addTransmitJob(jobData);
    }
  };

  const handleEditJob = (job: typeof transmitJobs[0]) => {
    // Load job data into the form
    // Ensure data array is padded to 8 bytes for editing
    const dataArray = [...(job.frame.data || [])];
    while (dataArray.length < 8) {
      dataArray.push(0);
    }
    
    const fullData = dataArray.slice(0, 8);
    setPendingTransmit({
      id: job.frame.id,
      isExtended: job.frame.isExtended,
      isRemote: job.frame.isRemote,
      dlc: job.frame.dlc,
      data: fullData, // Ensure exactly 8 bytes
    });
    
    // Update dataInputs immediately for editing
    const formatted = fullData.map(b => b.toString(16).toUpperCase().padStart(2, "0"));
    setDataInputs(formatted);
    
    setIntervalMs(job.intervalMs);
    setEditingJobId(job.id);
    // Set selected channel if available
    if (job.frame.channel) {
      setSelectedChannels([job.frame.channel]);
    }
  };

  const handleCancelEdit = () => {
    setEditingJobId(null);
    setPendingTransmit({
      id: 0x100,
      isExtended: false,
      isRemote: false,
      dlc: 8,
      data: [0, 0, 0, 0, 0, 0, 0, 0],
    });
    setDataInputs(Array(8).fill("00"));
    setIntervalMs(100);
    setSelectedChannels([]);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-can-border">
        <h2 className="panel-title mb-4">Transmit</h2>

        {/* Message Editor */}
        <div className="space-y-3">
          {/* Channel Selection */}
          {connectedChannels.length > 0 && (
            <div>
              <label className="label block mb-1.5">Channels</label>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {connectedChannels.map((channel) => (
                  <label key={channel.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="rounded border-can-border bg-can-bg-tertiary"
                      checked={selectedChannels.includes(channel.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedChannels([...selectedChannels, channel.id]);
                        } else {
                          setSelectedChannels(selectedChannels.filter(id => id !== channel.id));
                        }
                      }}
                    />
                    <span className="text-can-text-secondary">{channel.name}</span>
                  </label>
                ))}
              </div>
              {selectedChannels.length === 0 && (
                <p className="text-xs text-can-text-muted mt-1">
                  No channels selected. Will use active channel or all connected channels.
                </p>
              )}
            </div>
          )}
          
          {/* ID & Flags */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="label block mb-1.5">ID (Hex)</label>
              <input
                type="text"
                className="input w-full font-mono"
                value={`0x${(pendingTransmit.id || 0).toString(16).toUpperCase()}`}
                onChange={(e) => handleIdChange(e.target.value)}
                disabled={!hasConnectedChannels && !editingJobId}
              />
            </div>
            <div className="w-16">
              <label className="label block mb-1.5">DLC</label>
              <input
                type="number"
                className="input w-full font-mono text-center"
                value={pendingTransmit.dlc || 8}
                onChange={(e) => handleDlcChange(Number(e.target.value))}
                min={0}
                max={8}
                disabled={!hasConnectedChannels && !editingJobId}
              />
            </div>
          </div>

          {/* Flags */}
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="rounded border-can-border bg-can-bg-tertiary"
                checked={pendingTransmit.isExtended || false}
                onChange={(e) =>
                  setPendingTransmit({ isExtended: e.target.checked })
                }
                disabled={!hasConnectedChannels && !editingJobId}
              />
              <span className="text-can-text-secondary">Extended ID</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="rounded border-can-border bg-can-bg-tertiary"
                checked={pendingTransmit.isRemote || false}
                onChange={(e) =>
                  setPendingTransmit({ isRemote: e.target.checked })
                }
                disabled={!hasConnectedChannels && !editingJobId}
              />
              <span className="text-can-text-secondary">Remote Frame</span>
            </label>
          </div>

          {/* Data Bytes */}
          <div>
            <label className="label block mb-1.5">Data (Hex)</label>
            <div className="grid grid-cols-8 gap-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <input
                  key={i}
                  type="text"
                  className={`input font-mono text-center text-xs px-1 ${
                    i >= (pendingTransmit.dlc || 8)
                      ? "opacity-30"
                      : ""
                  }`}
                  value={dataInputs[i] || "00"}
                  onChange={(e) => handleDataChange(i, e.target.value)}
                  onBlur={() => handleDataBlur(i)}
                  maxLength={2}
                  disabled={(!hasConnectedChannels && !editingJobId) || i >= (pendingTransmit.dlc || 8)}
                />
              ))}
            </div>
          </div>

          {/* Send Button */}
          <button
            className="btn btn-primary w-full flex items-center justify-center gap-2"
            onClick={handleSend}
            disabled={!hasConnectedChannels}
          >
            <PaperAirplaneIcon className="w-4 h-4" />
            Send Message
          </button>
        </div>
      </div>

      {/* Periodic Transmit */}
      <div className="flex-1 p-4 overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-can-text-primary">
            Periodic Transmit
          </h3>
          <div className="flex items-center gap-2">
            <input
              type="number"
              className="input w-20 text-xs font-mono"
              value={intervalMs}
              onChange={(e) => setIntervalMs(Number(e.target.value))}
              min={10}
              step={10}
            />
            <span className="text-xs text-can-text-muted">ms</span>
            {editingJobId ? (
              <>
                <button
                  className="btn btn-primary p-1.5"
                  onClick={handleAddPeriodic}
                  disabled={!hasConnectedChannels}
                  title="Update periodic job"
                >
                  Update
                </button>
                <button
                  className="btn btn-secondary p-1.5"
                  onClick={handleCancelEdit}
                  title="Cancel edit"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="btn btn-secondary p-1.5"
                onClick={handleAddPeriodic}
                disabled={!hasConnectedChannels}
                title="Add periodic job"
              >
                <PlusIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Periodic Jobs List */}
        <div className="space-y-2">
          {transmitJobs.length === 0 ? (
            <p className="text-sm text-can-text-muted text-center py-4">
              No periodic jobs configured
            </p>
          ) : (
            transmitJobs.map((job) => (
              <div
                key={job.id}
                className="p-2 bg-can-bg-tertiary rounded-lg flex items-center justify-between"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">
                      0x
                      {job.frame.id
                        .toString(16)
                        .toUpperCase()
                        .padStart(3, "0")}
                    </span>
                    <span className="text-xs text-can-text-muted">
                      @ {job.intervalMs}ms
                    </span>
                    {job.frame.channel && (
                      <span className="text-xs text-can-text-muted">
                        ({channels.find(c => c.id === job.frame.channel)?.name || job.frame.channel})
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-mono text-can-text-secondary truncate">
                    {job.frame.data
                      .slice(0, job.frame.dlc)
                      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
                      .join(" ")}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    className="btn btn-secondary p-1.5"
                    onClick={() => handleEditJob(job)}
                    disabled={job.enabled}
                    title="Edit job"
                  >
                    <PencilIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    className={`btn p-1.5 ${
                      job.enabled ? "btn-success" : "btn-secondary"
                    }`}
                    onClick={() => toggleTransmitJob(job.id)}
                    disabled={!hasConnectedChannels}
                    title={job.enabled ? "Pause" : "Start"}
                  >
                    {job.enabled ? (
                      <PauseIcon className="w-3.5 h-3.5" />
                    ) : (
                      <PlayIcon className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    className="btn btn-secondary p-1.5"
                    onClick={() => {
                      if (editingJobId === job.id) {
                        handleCancelEdit();
                      }
                      removeTransmitJob(job.id);
                    }}
                    title="Delete job"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

