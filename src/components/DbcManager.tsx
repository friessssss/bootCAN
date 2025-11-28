import { useCanStore } from "../stores/canStore";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpenIcon, XMarkIcon } from "./icons";

export function DbcManager() {
  const { loadedDbcFiles, loadDbc, removeDbc, activeChannel } = useCanStore();

  const handleLoadDbc = async () => {
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

      if (filePath && typeof filePath === "string" && activeChannel) {
        await loadDbc(activeChannel, filePath);
      }
    } catch (error) {
      console.error("Failed to load DBC:", error);
    }
  };

  const handleRemoveDbc = async (channelId: string) => {
    try {
      await removeDbc(channelId);
    } catch (error) {
      console.error("Failed to remove DBC:", error);
    }
  };

  return (
    <div className="p-4 space-y-2 border-b border-can-border">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-can-text-primary">DBC Files</h3>
        <button
          onClick={handleLoadDbc}
          className="btn btn-secondary text-xs"
          disabled={!activeChannel}
        >
          <FolderOpenIcon className="w-3 h-3" />
          Load
        </button>
      </div>

      {loadedDbcFiles.size === 0 ? (
        <div className="text-xs text-can-text-muted text-center py-2">
          No DBC files loaded
        </div>
      ) : (
        <div className="space-y-1">
          {Array.from(loadedDbcFiles.entries()).map(([channelId, filePath]) => (
            <div
              key={channelId}
              className="flex items-center justify-between text-xs bg-can-bg-tertiary rounded px-2 py-1"
            >
              <span className="truncate flex-1 text-can-text-secondary">
                {filePath.split("/").pop() || filePath}
              </span>
              <button
                onClick={() => handleRemoveDbc(channelId)}
                className="ml-2 text-can-text-muted hover:text-can-accent-red"
              >
                <XMarkIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

