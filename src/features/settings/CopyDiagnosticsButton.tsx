import { useEffect, useRef, useState } from "react";
import { copyDiagnostics } from "./diagnostics";
import { errorMessage } from "../../shared/lib/errors";
import { CheckIcon, CopyIcon } from "../../shared/ui/icons";

type CopyState = "idle" | "copying" | "copied" | "failed";

/**
 * Copies the redacted diagnostics report; shows the outcome next to the button.
 * `compact` shows "Copy" followed by a copy icon, laid out like the Settings View buttons (for places that
 * already say "Diagnostics" beside it).
 */
export function CopyDiagnosticsButton({
  className = "button primary",
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
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
      <button
        type="button"
        className={className}
        disabled={state === "copying"}
        aria-label={compact && state === "idle" ? "Copy diagnostics" : undefined}
        onClick={() => void copy()}
      >
        {compact ? (
          <>
            <span>{state === "copying" ? "Copying…" : state === "copied" ? "Copied!" : "Copy"}</span>
            {state === "copied" ? <CheckIcon /> : <CopyIcon />}
          </>
        ) : state === "copying" ? "Copying…" : state === "copied" ? "Copied!" : "Copy Diagnostics"}
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
