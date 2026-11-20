import { useCallback, useState } from "react";
import type { CommandError } from "../../types";

export type AppError = { source: string; message: string };

/**
 * Shows an error banner for `source`; `context` says what was being done. Provided by `useAppErrors`.
 * When `context` names an account, pass `diagnosticContext` without the name: that is what Copy
 * Diagnostics keeps, so the report carries no account labels, as the backend report does not.
 */
export type ReportError = (source: string, cause: unknown, context?: string, diagnosticContext?: string) => void;

/**
 * The error a backend command rejected with (`{ code, message }`, `commands/error.rs`), or null
 * for anything else: a JavaScript error, or a string from Tauri itself (an unknown command, a
 * permission denial).
 */
export function commandError(cause: unknown): CommandError | null {
  if (!cause || typeof cause !== "object") return null;
  const { code, message } = cause as Partial<Record<keyof CommandError, unknown>>;
  return typeof code === "string" && typeof message === "string" ? (cause as CommandError) : null;
}

/** Turns anything thrown (Error, Tauri's string rejections, a command's `{ code, message }`) into readable text. */
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
 * backend sanitizes its errors to plain sentences) and are shown as they are. A failed request is
 * plain too: the backend sends a sentence that says to check the connection
 * (`providers::request_failed`), never the request's own text.
 */
export type ErrorKind = "backend" | "technical" | "plain";

const BACKEND_PATTERN =
  /cannot read propert|is not a function|is not defined|\bundefined\b|__tauri|\binvoke\b|\bipc\b|command \S+ not found|not allowed\b.*\b(command|acl|permission)/i;
const TECHNICAL_PATTERN =
  /\b(Type|Reference|Syntax|Range)Error\b|\bat \S+:\d+|^\s*[{[]|"error"\s*:|\bHTTP\/?\s*[45]\d\d\b|status(?: code)?:? [45]\d\d|panicked|thread '|::\w+/i;

export function classifyError(raw: string): ErrorKind {
  if (BACKEND_PATTERN.test(raw)) return "backend";
  if (TECHNICAL_PATTERN.test(raw) || raw.length > 240) return "technical";
  return "plain";
}

const COPY_DIAGNOSTICS_HINT = "If it keeps happening, use Copy Diagnostics in Settings.";

const FRIENDLY: Record<Exclude<ErrorKind, "plain">, string> = {
  backend: `The app's background service isn't responding. Restart the app. ${COPY_DIAGNOSTICS_HINT}`,
  technical: `Something unexpected went wrong. Try again. ${COPY_DIAGNOSTICS_HINT}`,
};

/**
 * The text of a banner: what was being done, then a plain explanation and what to do next. A message
 * that is already readable keeps its detail ("Couldn't X: detail"), as before. A command error with a
 * code is the backend's own sentence and is shown as written: only text without one is classified.
 */
export function friendlyMessage(context: string | undefined, cause: unknown): string {
  const raw = errorMessage(cause);
  const coded = commandError(cause);
  const kind = coded && coded.code !== "unclassified" ? "plain" : classifyError(raw);
  if (kind === "plain") return context ? `${context}: ${raw}` : raw;
  const sentence = FRIENDLY[kind];
  return context ? `${context}. ${sentence}` : sentence;
}

// Raw detail behind each friendly banner, kept for Copy Diagnostics. In memory only, newest last.
const MAX_RECORDED = 20;
const MAX_DETAIL_LENGTH = 300;
const recorded: string[] = [];

/** Removes email addresses, home-folder names, and long token-like strings before a message is kept. */
export function redactDetail(raw: string): string {
  return raw
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    // "/Users/name/...", "/home/name/...", "C:\Users\name\..." -> "~/...", as the backend does.
    .replace(/(?:\/Users|\/home)\/[^/\s]+/g, "~")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/gi, "~")
    .replace(/\b[A-Za-z0-9_\-+/=]{24,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
}

/** Keeps one line for Copy Diagnostics. The whole line is redacted: source and context too, not just the cause. */
export function recordErrorDetail(source: string, context: string | undefined, raw: string): void {
  const line = `${new Date().toISOString()} ${redactDetail(`[${source}] ${context ? `${context}: ` : ""}${raw}`)}`;
  recorded.push(line);
  if (recorded.length > MAX_RECORDED) recorded.shift();
}

/**
 * The text for an error shown next to the thing that failed (a modal, a hook's own message), as
 * `useAppErrors` builds it for the banners: `friendlyMessage`, with the raw detail kept for Copy
 * Diagnostics. `source` names the feature in that report.
 */
export function describeError(source: string, context: string | undefined, cause: unknown): string {
  const raw = errorMessage(cause);
  recordErrorDetail(source, context, raw);
  return friendlyMessage(context, cause);
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
  const report = useCallback((source: string, cause: unknown, context?: string, diagnosticContext?: string) => {
    const raw = errorMessage(cause);
    recordErrorDetail(source, diagnosticContext ?? context, raw);
    setErrors((current) => reportError(current, source, friendlyMessage(context, cause)));
  }, []);
  const clear = useCallback((source: string) => {
    setErrors((current) => clearError(current, source));
  }, []);
  return { errors, report, clear };
}
