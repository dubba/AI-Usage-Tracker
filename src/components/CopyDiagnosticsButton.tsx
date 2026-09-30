import { useEffect, useRef, useState } from "react";
import { copyDiagnostics } from "../diagnostics";
import { errorMessage } from "../errors";

type CopyState = "idle" | "copying" | "copied" | "failed";

/** Copies the redacted diagnostics report; shows the outcome next to the button. */
export function CopyDiagnosticsButton({ className = "button ghost" }: { className?: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    setState("copying");
    setFailure(null);
    try {
      await copyDiagnostics();
      setState("copied");
      resetTimer.current = window.setTimeout(() => setState("idle"), 2500);
    } catch (cause) {
      setFailure(errorMessage(cause));
      setState("failed");
    }
  };

  return (
    <>
      <button type="button" className={className} disabled={state === "copying"} onClick={() => void copy()}>
        {state === "copying" ? "Copying…" : state === "copied" ? "Copied!" : "Copy diagnostics"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? "Diagnostics copied to the clipboard." : ""}
      </span>
      {state === "failed" ? (
        <span className="copy-diagnostics-error" role="alert">
          Unable to copy: {failure}
        </span>
      ) : null}
    </>
  );
}
