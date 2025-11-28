import { useCanStore } from "../stores/canStore";
import { PlusIcon, XMarkIcon, FolderOpenIcon } from "./icons";
import { open } from "@tauri-apps/plugin-dialog";

export function ChannelManager() {
  const { 
    channels, 
    activeChannel, 
    setActiveChannel, 
    addChannel, 
    removeChannel,
    updateChannel,
    connectChannel,
    disconnectChannel,
    availableInterfaces,
    loadedDbcFiles,
    loadDbc,
    removeDbc,
  } = useCanStore();

  const formatBitrate = (bitrate: number) => {
    if (bitrate >= 1000000) return `${bitrate / 1000000}M`;
    return `${bitrate / 1000}k`;
  };

  const getChannelDbcFile = (channelId: string) => {
    const dbcEntry = Array.from(loadedDbcFiles.entries()).find(([id]) => id === channelId);
    return dbcEntry ? dbcEntry[1].split("/").pop() || dbcEntry[1] : null;
  };

  const handleLoadDbc = async (channelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const filePath = await open({
        title: "Load DBC/SYM File",
        filters: [
          { name: "DBC/SYM Files", extensions: ["dbc", "sym"] },
          { name: "DBC Files", extensions: ["dbc"] },
          { name: "SYM Files", extensions: ["sym"] },
        ],
        multiple: false,
      });

      if (filePath && typeof filePath === "string") {
        await loadDbc(channelId, filePath);
      }
    } catch (error) {
      console.error("Failed to load DBC:", error);
    }
  };

  const handleRemoveDbc = async (channelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await removeDbc(channelId);
    } catch (error) {
      console.error("Failed to remove DBC:", error);
    }
  };

  return (
    <div className="p-4 space-y-2 border-b border-can-border">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-can-text-primary">Channels</h3>
        <button
          onClick={() => addChannel()}
          className="btn btn-secondary text-xs"
        >
          <PlusIcon className="w-3 h-3" />
          Add
        </button>
      </div>

      <div className="space-y-1">
        {channels.length === 0 ? (
          <div className="text-xs text-can-text-muted text-center py-2">
            No channels. Click Add to create one.
          </div>
        ) : (
          channels.map((channel, index) => {
            const isActive = activeChannel === channel.id;
            const interfaceName = channel.interfaceId 
              ? availableInterfaces.find((i) => i.id === channel.interfaceId)?.name || channel.interfaceId
              : "Not set";
            const dbcFile = getChannelDbcFile(channel.id) || channel.dbcFile?.split("/").pop() || null;
            const bitrateStr = formatBitrate(channel.bitrate);
            
            // Format: "Channel 1, VirtualCAN 0, 500k, xxx.dbc"
            const channelLabel = `Channel ${index + 1}, ${interfaceName}, ${bitrateStr}${dbcFile ? `, ${dbcFile}` : ""}`;
            
            return (
              <div
                key={channel.id}
                className={`rounded px-2 py-1.5 cursor-pointer border ${
                  isActive
                    ? "bg-can-accent-blue text-white border-can-accent-blue"
                    : "bg-can-bg-tertiary text-can-text-secondary hover:bg-can-bg-primary border-can-border"
                }`}
                onClick={() => setActiveChannel(channel.id)}
              >
                <div className="flex items-center justify-between mb-1">
                  <input
                    type="text"
                    value={channel.name}
                    onChange={(e) => {
                      e.stopPropagation();
                      updateChannel(channel.id, { name: e.target.value });
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className={`text-xs font-medium bg-transparent border-none outline-none flex-1 ${
                      isActive ? "text-white" : "text-can-text-secondary"
                    }`}
                    placeholder={`Channel ${index + 1}`}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeChannel(channel.id);
                    }}
                    className="hover:text-can-accent-red ml-2"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </div>
                <div className="text-xxs space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="opacity-75">Interface:</span>
                    <select
                      className={`text-xxs px-1 py-0 rounded ${
                        isActive ? "bg-white/20 text-white" : "bg-can-bg-primary text-can-text-primary"
                      }`}
                      value={channel.interfaceId || ""}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        updateChannel(channel.id, { interfaceId: e.target.value || null });
                      }}
                    >
                      <option value="">Select...</option>
                      {availableInterfaces.map((iface) => (
                        <option key={iface.id} value={iface.id}>
                          {iface.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="opacity-75">Bitrate:</span>
                    <select
                      className={`text-xxs px-1 py-0 rounded ${
                        isActive ? "bg-white/20 text-white" : "bg-can-bg-primary text-can-text-primary"
                      }`}
                      value={channel.bitrate}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        updateChannel(channel.id, { bitrate: Number(e.target.value) });
                      }}
                    >
                      <option value={125000}>125k</option>
                      <option value={250000}>250k</option>
                      <option value={500000}>500k</option>
                      <option value={1000000}>1M</option>
                    </select>
                  </div>
                  {dbcFile ? (
                    <div className="flex items-center justify-between">
                      <span className="opacity-75">DBC:</span>
                      <div className="flex items-center gap-1">
                        <span className="truncate max-w-[100px] text-xxs">{dbcFile}</span>
                        <button
                          onClick={(e) => handleRemoveDbc(channel.id, e)}
                          className="text-can-text-muted hover:text-can-accent-red"
                          title="Remove DBC file"
                        >
                          <XMarkIcon className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="opacity-75">DBC:</span>
                      <button
                        onClick={(e) => handleLoadDbc(channel.id, e)}
                        className={`text-xxs px-1 py-0.5 rounded ${
                          isActive ? "bg-white/20 text-white hover:bg-white/30" : "bg-can-bg-primary text-can-text-primary hover:bg-can-bg-tertiary"
                        }`}
                        title="Load DBC/SYM file"
                      >
                        <FolderOpenIcon className="w-2.5 h-2.5 inline mr-0.5" />
                        Load
                      </button>
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-1">
                    <span className={`text-xxs ${
                      channel.connectionStatus === "connected" ? "text-can-accent-green" :
                      channel.connectionStatus === "error" ? "text-can-accent-red" :
                      "opacity-50"
                    }`}>
                      {channel.connectionStatus === "connected" ? "● Connected" :
                       channel.connectionStatus === "connecting" ? "● Connecting..." :
                       channel.connectionStatus === "error" ? "● Error" :
                       "○ Disconnected"}
                    </span>
                    {channel.interfaceId && (
                      <button
                        className={`text-xxs px-1.5 py-0.5 rounded ${
                          channel.connectionStatus === "connected"
                            ? "bg-can-accent-red/20 text-can-accent-red"
                            : "bg-can-accent-green/20 text-can-accent-green"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (channel.connectionStatus === "connected") {
                            disconnectChannel(channel.id);
                          } else {
                            connectChannel(channel.id);
                          }
                        }}
                      >
                        {channel.connectionStatus === "connected" ? "Disconnect" : "Connect"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

