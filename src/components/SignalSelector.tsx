import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCanStore, PlotSignal } from "../stores/canStore";
import { MagnifyingGlassIcon, ChevronDownIcon, XMarkIcon } from "./icons";

interface SignalInfo {
  name: string;
  unit: string;
  valueType: string;
}

interface MessageWithSignals {
  channelId: string;
  messageId: number;
  messageName: string;
  signals: SignalInfo[];
}

interface SignalOption {
  channelId: string;
  messageId: number;
  messageName: string;
  signalName: string;
  unit: string;
  valueType: string;
  displayText: string;
}

export function SignalSelector() {
  const { selectedPlotSignals, addPlotSignal, removePlotSignal, channels } = useCanStore();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [allSignals, setAllSignals] = useState<MessageWithSignals[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());

  // Fetch all signals when component mounts or when DBC files change
  useEffect(() => {
    const fetchSignals = async () => {
      setLoading(true);
      try {
        const signals = await invoke<MessageWithSignals[]>("get_all_signals");
        setAllSignals(signals);
      } catch (error) {
        console.error("Failed to fetch signals:", error);
        setAllSignals([]);
      } finally {
        setLoading(false);
      }
    };

    fetchSignals();
  }, []);

  // Get unique channels from all signals, using channel names for display
  const availableChannels = useMemo(() => {
    const channelMap = new Map<string, { id: string; name: string }>();
    for (const msg of allSignals) {
      if (!channelMap.has(msg.channelId)) {
        const channelName = channels.find(c => c.id === msg.channelId)?.name || msg.channelId;
        channelMap.set(msg.channelId, { id: msg.channelId, name: channelName });
      }
    }
    // Sort by channel name for display
    return Array.from(channelMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [allSignals, channels]);

  // Initialize selected channels to all channels when signals are first loaded
  useEffect(() => {
    if (availableChannels.length > 0 && selectedChannels.size === 0) {
      setSelectedChannels(new Set(availableChannels.map(c => c.id)));
    }
  }, [availableChannels]);

  // Create flat list of signal options, sorted alphabetically
  const signalOptions = useMemo(() => {
    const options: SignalOption[] = [];
    
      for (const msg of allSignals) {
        // Filter by selected channels (using channel IDs internally)
        if (selectedChannels.size > 0 && !selectedChannels.has(msg.channelId)) {
          continue;
        }

      for (const signal of msg.signals) {
        // Skip non-numeric signals (enumerated/boolean for MVP)
        if (signal.valueType === "unsigned" || signal.valueType === "signed" || 
            signal.valueType === "float" || signal.valueType === "double") {
          const channelName = channels.find(c => c.id === msg.channelId)?.name || msg.channelId;
          const idHex = `0x${msg.messageId.toString(16).toUpperCase().padStart(3, "0")}`;
          const displayText = `${signal.name} (${msg.messageName} @ ${idHex})${signal.unit ? ` [${signal.unit}]` : ""}`;
          
          options.push({
            channelId: msg.channelId,
            messageId: msg.messageId,
            messageName: msg.messageName,
            signalName: signal.name,
            unit: signal.unit,
            valueType: signal.valueType,
            displayText,
          });
        }
      }
    }
    
    // Sort alphabetically by signal name
    return options.sort((a, b) => a.signalName.localeCompare(b.signalName));
  }, [allSignals, channels, selectedChannels]);

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    let filtered = signalOptions;
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(opt => 
        opt.signalName.toLowerCase().includes(query) ||
        opt.messageName.toLowerCase().includes(query) ||
        opt.displayText.toLowerCase().includes(query)
      );
    }
    
    return filtered;
  }, [signalOptions, searchQuery]);

  // Check if a signal is already selected
  const isSignalSelected = (option: SignalOption) => {
    return selectedPlotSignals.some(
      sig => sig.channelId === option.channelId &&
             sig.messageId === option.messageId &&
             sig.signalName === option.signalName
    );
  };

  const handleToggleSignal = (option: SignalOption) => {
    if (isSignalSelected(option)) {
      removePlotSignal({
        channelId: option.channelId,
        messageId: option.messageId,
        signalName: option.signalName,
      });
    } else {
      addPlotSignal({
        channelId: option.channelId,
        messageId: option.messageId,
        signalName: option.signalName,
      });
    }
    // Don't close dropdown - allow multi-select
  };

  const handleToggleChannel = (channelId: string) => {
    setSelectedChannels(prev => {
      const next = new Set(prev);
      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }
      return next;
    });
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="btn btn-secondary flex items-center justify-between min-w-[200px]"
      >
        <span className="text-sm">Add Signal</span>
        <ChevronDownIcon className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => {
              setIsOpen(false);
              setSearchQuery("");
            }}
          />

          {/* Dropdown */}
          <div 
            className="absolute z-20 w-[600px] mt-1 bg-can-bg-secondary border border-can-border rounded-md shadow-lg max-h-96 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="p-2 border-b border-can-border">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-can-text-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search signals..."
                  className="input w-full pl-8 pr-2 py-1.5 text-sm"
                  autoFocus
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2 top-1/2 transform -translate-y-1/2"
                  >
                    <XMarkIcon className="w-4 h-4 text-can-text-muted hover:text-can-text-primary" />
                  </button>
                )}
              </div>
            </div>

            {/* Channel filters */}
            {availableChannels.length > 1 && (
              <div className="p-2 border-b border-can-border">
                <div className="text-xs text-can-text-secondary mb-1.5">Filter by Channel:</div>
                <div className="flex flex-wrap gap-2">
                  {availableChannels.map((channel) => {
                    const isSelected = selectedChannels.has(channel.id);
                    return (
                      <label
                        key={channel.id}
                        className="flex items-center gap-1.5 px-2 py-1 bg-can-bg-tertiary rounded text-xs cursor-pointer hover:bg-can-bg-hover transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleChannel(channel.id)}
                          className="w-3 h-3 rounded border-can-border text-can-accent-blue focus:ring-can-accent-blue"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="text-can-text-primary">{channel.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Options list */}
            <div className="overflow-y-auto flex-1">
              {loading ? (
                <div className="p-4 text-center text-sm text-can-text-muted">
                  Loading signals...
                </div>
              ) : filteredOptions.length === 0 ? (
                <div className="p-4 text-center text-sm text-can-text-muted">
                  {searchQuery ? "No signals found" : "No signals available. Load a DBC file first."}
                </div>
              ) : (
                <div className="py-1">
                  {filteredOptions.map((option, idx) => {
                    const selected = isSignalSelected(option);
                    return (
                      <label
                        key={`${option.channelId}-${option.messageId}-${option.signalName}-${idx}`}
                        className={`w-full px-3 py-2 flex items-start gap-2 text-sm hover:bg-can-bg-hover transition-colors cursor-pointer ${
                          selected
                            ? "bg-can-bg-tertiary"
                            : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => handleToggleSignal(option)}
                          className="mt-0.5 w-4 h-4 rounded border-can-border text-can-accent-blue focus:ring-can-accent-blue flex-shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={`font-medium truncate flex-1 ${selected ? "text-can-accent-blue" : "text-can-text-primary"}`}>
                              {option.signalName}
                            </span>
                          </div>
                          <div className="text-xs text-can-text-secondary mt-0.5 truncate">
                            {option.messageName} @ 0x{option.messageId.toString(16).toUpperCase().padStart(3, "0")}
                            {option.unit && ` • ${option.unit}`}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

