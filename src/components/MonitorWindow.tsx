import { useEffect } from "react";
import { useCanStore } from "../stores/canStore";
import { ReceiveList } from "./ReceiveList";
import { TraceList } from "./TraceList";
import { TransmitTable } from "./TransmitTable";
import { Splitter } from "./Splitter";

/**
 * PCX7-style combined window: receive list (or trace) on top, full-width
 * transmit table below, separated by a draggable splitter.
 * Spacebar sends the selected transmit row once.
 */
export function MonitorWindow() {
  const viewMode = useCanStore((s) => s.viewMode);
  const selectedTransmitRowId = useCanStore((s) => s.selectedTransmitRowId);
  const sendTransmitRowOnce = useCanStore((s) => s.sendTransmitRowOnce);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement;
      // Don't hijack typing or dialogs
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable ||
        document.querySelector('[role="dialog"], .fixed.inset-0')
      ) {
        return;
      }
      if (selectedTransmitRowId) {
        e.preventDefault();
        sendTransmitRowOnce(selectedTransmitRowId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedTransmitRowId, sendTransmitRowOnce]);

  return (
    <Splitter
      storageKey="monitor-split"
      defaultPercent={62}
      top={viewMode === "monitor" ? <ReceiveList /> : <TraceList />}
      bottom={<TransmitTable />}
    />
  );
}
