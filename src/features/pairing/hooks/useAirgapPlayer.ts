import { useEffect, useState } from "react";
import type { AirgapExport } from "../../../types";

export type AirgapSpeed = "normal" | "slow";

const FRAME_INTERVAL_MS: Record<AirgapSpeed, number> = { normal: 150, slow: 280 };

/** Steps through the animated QR frames of an air-gap export while `active` and playing. */
export function useAirgapPlayer(exportData: AirgapExport | null, active: boolean) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<AirgapSpeed>("normal");

  useEffect(() => {
    if (!active || !exportData || !playing) return;
    const total = exportData.frames.length;
    if (total <= 1) return;
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % total);
    }, FRAME_INTERVAL_MS[speed]);
    return () => clearInterval(timer);
  }, [active, exportData, playing, speed]);

  return {
    frameIndex,
    playing,
    speed,
    togglePlaying: () => setPlaying((current) => !current),
    toggleSpeed: () => setSpeed((current) => (current === "normal" ? "slow" : "normal")),
    /** Back to the first frame, playing. */
    restart: () => {
      setFrameIndex(0);
      setPlaying(true);
    },
  };
}
