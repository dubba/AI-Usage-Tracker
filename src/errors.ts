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
 * Errors stay visible until dismissed, or until the operation that produced
 * them (identified by `source`) succeeds again.
 */
export function useAppErrors() {
  const [errors, setErrors] = useState<AppError[]>([]);
  const report = useCallback((source: string, cause: unknown, context?: string) => {
    const detail = errorMessage(cause);
    setErrors((current) => reportError(current, source, context ? `${context}: ${detail}` : detail));
  }, []);
  const clear = useCallback((source: string) => {
    setErrors((current) => clearError(current, source));
  }, []);
  return { errors, report, clear };
}
