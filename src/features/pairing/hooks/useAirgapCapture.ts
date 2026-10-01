import { useEffect, useRef, useState } from "react";
import { pairingApi } from "../../../shared/lib/api";

/**
 * The receiving side of an air-gap transfer: frames captured by the camera, the code to compare
 * with the sender, and the progress flags around them. When every frame is in, it asks the
 * backend for the verification code; if that fails it clears the capture and asks to scan again.
 */
export function useAirgapCapture({
  active,
  onVerifyStart,
  onVerifyError,
  onRescan,
}: {
  /** The scanner is on screen. */
  active: boolean;
  /** Verification is starting; the caller clears any earlier error. */
  onVerifyStart: () => void;
  onVerifyError: (message: string) => void;
  /** Frames were thrown away; restart the camera scan. */
  onRescan: () => void;
}) {
  const [chunks, setChunks] = useState<Map<number, string>>(new Map());
  const [total, setTotal] = useState(0);
  const [verifyPrompt, setVerifyPrompt] = useState(false);
  const [verifyCode, setVerifyCode] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [captureSecs, setCaptureSecs] = useState<number | null>(null);

  // Written by the scanner as frames arrive, read by effects and handlers.
  const sessionIdRef = useRef<string | null>(null);
  const verifyPromptRef = useRef(false);
  const captureStartRef = useRef<number | null>(null);
  const verifyStartedRef = useRef(false);

  // Latest callbacks, read inside the verification effect without making it re-run.
  const callbacksRef = useRef({ onVerifyStart, onVerifyError, onRescan });
  callbacksRef.current = { onVerifyStart, onVerifyError, onRescan };

  /** Forget the captured frames and the transfer they belong to. */
  const clearCapture = () => {
    setChunks(new Map());
    setTotal(0);
    setVerifyCode(null);
    verifyStartedRef.current = false;
    sessionIdRef.current = null;
    captureStartRef.current = null;
    setCaptureSecs(null);
  };

  /** Back from the code comparison to scanning the same transfer again. */
  const rescan = () => {
    setVerifyPrompt(false);
    verifyPromptRef.current = false;
    verifyStartedRef.current = false;
    captureStartRef.current = null;
    setCaptureSecs(null);
    setChunks(new Map());
    setVerifyCode(null);
  };

  /** The comparison is finished (the frames were imported). */
  const closePrompt = () => {
    verifyPromptRef.current = false;
    setVerifyPrompt(false);
  };

  /** Everything, for when the dialog closes. */
  const resetAll = () => {
    clearCapture();
    setVerifyPrompt(false);
    verifyPromptRef.current = false;
    setVerifying(false);
    setImporting(false);
  };

  // When all frames are captured, ask the backend for the code to compare with the sender.
  // Do not put `verifying` in the deps: flipping it to true used to cancel this effect and skip a
  // new run, leaving "Checking captured frames…" on screen forever.
  useEffect(() => {
    if (!active || !verifyPrompt) return;
    if (verifyCode || verifyStartedRef.current) return;
    if (total === 0 || chunks.size < total) return;
    verifyStartedRef.current = true;
    setVerifying(true);
    callbacksRef.current.onVerifyStart();
    void pairingApi
      .verifyAirgapFrames(Array.from(chunks.values()))
      .then((res) => {
        setVerifyCode(res.verifyCode);
      })
      .catch((err) => {
        callbacksRef.current.onVerifyError(err instanceof Error ? err.message : String(err));
        verifyStartedRef.current = false;
        setVerifyPrompt(false);
        verifyPromptRef.current = false;
        captureStartRef.current = null;
        setCaptureSecs(null);
        setChunks(new Map());
        sessionIdRef.current = null;
        callbacksRef.current.onRescan();
      })
      .finally(() => {
        setVerifying(false);
      });
  }, [active, verifyPrompt, chunks, total, verifyCode]);

  return {
    chunks,
    setChunks,
    total,
    setTotal,
    verifyPrompt,
    setVerifyPrompt,
    verifyCode,
    verifying,
    importing,
    setImporting,
    captureSecs,
    setCaptureSecs,
    sessionIdRef,
    verifyPromptRef,
    captureStartRef,
    clearCapture,
    rescan,
    closePrompt,
    resetAll,
  };
}
