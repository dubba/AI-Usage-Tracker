import { useCallback, useState } from "react";

export type AppError = { source: string; message: string };

/** Turns anything thrown (Error, Tauri's string rejections, objects) into readable text. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message.trim() || "Something went wrong.";
  if (typeof cause === "string") return cause.trim() || "Something went wrong.";
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
    return cause.message.trim() || "Something went wrong.";
  }
  return String(cause);
}

/**
 * Adds or replaces the error for `source`. Each source holds at most one
 * message, so a repeating failure updates in place instead of stacking up.
 */
export function reportError(errors: AppError[], source: string, message: string): AppError[] {
  const index = errors.findIndex((entry) => entry.source === source);
  if (index === -1) return [...errors, { source, message }];
  if (errors[index].message === message) return errors;
  return errors.map((entry, i) => (i === index ? { source, message } : entry));
}

export function clearError(errors: AppError[], source: string): AppError[] {
  return errors.some((entry) => entry.source === source)
    ? errors.filter((entry) => entry.source !== source)
    : errors;
}

/**
 * What kind of failure a raw message describes. "plain" messages are already written for people (the
 * backend sanitises its errors to plain sentences) and are shown as they are.
 */
export type ErrorKind = "backend" | "network" | "technical" | "plain";

const BACKEND_PATTERN =
  /cannot read propert|is not a function|is not defined|\bundefined\b|__tauri|\binvoke\b|\bipc\b|command \S+ not found|not allowed\b.*\b(command|acl|permission)/i;
// Low-level connection errors only. Backend sentences such as "Grok login timed out. Start the
// connection again." are already clear and stay as they are.
const NETWORK_PATTERN =
  /failed to fetch|network ?error|network request failed|error sending request|connection (refused|reset|closed)|operation timed out|\bdns error|network is unreachable|tcp connect|os error \d+/i;
const TECHNICAL_PATTERN =
  /\b(Type|Reference|Syntax|Range)Error\b|\bat \S+:\d+|^\s*[{[]|"error"\s*:|\bHTTP\/?\s*[45]\d\d\b|status(?: code)?:? [45]\d\d|panicked|thread '|::\w+/i;

export function classifyError(raw: string): ErrorKind {
  if (BACKEND_PATTERN.test(raw)) return "backend";
  if (NETWORK_PATTERN.test(raw)) return "network";
  if (TECHNICAL_PATTERN.test(raw) || raw.length > 240) return "technical";
  return "plain";
}

const COPY_DIAGNOSTICS_HINT = "If it keeps happening, use Copy Diagnostics in Settings.";

const FRIENDLY: Record<Exclude<ErrorKind, "plain">, string> = {
  backend: `The app's background service isn't responding. Restart the app. ${COPY_DIAGNOSTICS_HINT}`,
  network: "Check your internet connection and try again.",
  technical: `Something unexpected went wrong. Try again. ${COPY_DIAGNOSTICS_HINT}`,
};

/**
 * The text of a banner: what was being done, then a plain explanation and what to do next. A message
 * that is already readable keeps its detail ("Couldn't X: detail"), as before.
 */
export function friendlyMessage(context: string | undefined, raw: string): string {
  const kind = classifyError(raw);
  if (kind === "plain") return context ? `${context}: ${raw}` : raw;
  const sentence = FRIENDLY[kind];
  return context ? `${context}. ${sentence}` : sentence;
}

// Raw detail behind each friendly banner, kept for Copy Diagnostics. In memory only, newest last.
const MAX_RECORDED = 20;
const MAX_DETAIL_LENGTH = 300;
const recorded: string[] = [];

/** Removes email addresses and long token-like strings before a message is kept. */
export function redactDetail(raw: string): string {
  return raw
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b[A-Za-z0-9_\-+/=]{24,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
}

export function recordErrorDetail(source: string, context: string | undefined, raw: string): void {
  const line = `${new Date().toISOString()} [${source}] ${context ? `${context}: ` : ""}${redactDetail(raw)}`;
  recorded.push(line);
  if (recorded.length > MAX_RECORDED) recorded.shift();
}

export function recentErrorDetails(): string[] {
  return [...recorded];
}

export function clearRecordedErrorDetails(): void {
  recorded.length = 0;
}

/**
 * Errors stay visible until dismissed, or until the operation that produced
 * them (identified by `source`) succeeds again.
 */
export function useAppErrors() {
  const [errors, setErrors] = useState<AppError[]>([]);
  const report = useCallback((source: string, cause: unknown, context?: string) => {
    const raw = errorMessage(cause);
    recordErrorDetail(source, context, raw);
    setErrors((current) => reportError(current, source, friendlyMessage(context, raw)));
  }, []);
  const clear = useCallback((source: string) => {
    setErrors((current) => clearError(current, source));
  }, []);
  return { errors, report, clear };
}
