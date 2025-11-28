import { useEffect, useState } from "react";
import { useCanStore } from "../stores/canStore";
import { invoke } from "@tauri-apps/api/core";

interface DecodedSignal {
  name: string;
  rawValue: number;
  physicalValue: number;
  unit: string;
  valueName?: string;
}

export function SignalInspector() {
  const { selectedMessage, loadedDbcFiles, selectedInterface } = useCanStore();
  const [decodedSignals, setDecodedSignals] = useState<DecodedSignal[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const decodeSignals = async () => {
      if (!selectedMessage || !selectedInterface) {
        setDecodedSignals([]);
        return;
      }

      // Check if DBC is loaded for this channel
      if (!loadedDbcFiles.has(selectedInterface)) {
        setDecodedSignals([]);
        return;
      }

      setLoading(true);
      try {
        const signals = await invoke<DecodedSignal[]>("decode_message", {
          channelId: selectedInterface,
          messageId: selectedMessage.id,
          data: selectedMessage.data,
        });
        setDecodedSignals(signals);
      } catch (error) {
        console.error("Failed to decode signals:", error);
        setDecodedSignals([]);
      } finally {
        setLoading(false);
      }
    };

    decodeSignals();
  }, [selectedMessage, loadedDbcFiles, selectedInterface]);

  if (!selectedMessage || !loadedDbcFiles.has(selectedInterface || "")) {
    return (
      <div className="p-4 text-xs text-can-text-muted text-center">
        Select a message to view decoded signals
        {!loadedDbcFiles.has(selectedInterface || "") && (
          <div className="mt-2 text-xxs">
            Load a DBC file to enable signal decoding
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 text-xs text-can-text-muted text-center">
        Decoding signals...
      </div>
    );
  }

  if (decodedSignals.length === 0) {
    return (
      <div className="p-4 text-xs text-can-text-muted text-center">
        No signals decoded for this message
      </div>
    );
  }

  return (
    <div className="p-4 space-y-2">
      <h3 className="text-sm font-semibold text-can-text-primary mb-2">
        Decoded Signals
      </h3>
      <div className="space-y-1">
        {decodedSignals.map((signal, idx) => (
          <div
            key={idx}
            className="bg-can-bg-tertiary rounded px-2 py-1.5 text-xs"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-can-text-primary">
                {signal.name}
              </span>
              {signal.valueName && (
                <span className="text-can-accent-yellow text-xxs">
                  {signal.valueName}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between text-can-text-secondary">
              <span>
                {signal.physicalValue.toFixed(3)} {signal.unit}
              </span>
              <span className="text-xxs font-mono">
                Raw: {signal.rawValue}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

