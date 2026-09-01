import type { UsageWindow } from "../types";

function formatReset(value: string | null): string {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  return `Resets ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function cleanModelPrefix(prefix: string): string {
  return prefix
    .replace(/\bclaude\s+and\s+gpt\b/i, "Claude & GPT")
    .replace(/\s+models$/i, "")
    .replace(/\s+model$/i, "")
    .trim();
}

export function UsageBar({ window }: { window: UsageWindow }) {
  const remaining = window.remainingPercent;
  const width = remaining == null ? 0 : Math.min(100, Math.max(0, remaining));
  const tone = remaining == null ? "neutral" : remaining <= 10 ? "danger" : remaining <= 30 ? "warning" : "good";

  const lower = window.label.toLowerCase();
  const is5h = (window.windowSeconds != null && window.windowSeconds <= 86_400) || window.id.includes("five_hour") || lower.includes("5 hour") || lower.includes("five hour");
  const is7d = window.windowSeconds === 604_800 || window.id.includes("weekly") || lower.includes("weekly") || lower.includes("7 day");
  const pillClass = is5h ? "window-pill-5h" : is7d ? "window-pill-7d" : "";
  let displayLabel = cleanModelPrefix(window.label);
  if (window.label.includes(" · ")) {
    const parts = window.label.split(" · ");
    const prefix = cleanModelPrefix(parts.slice(0, -1).join(" · "));
    const last = parts[parts.length - 1].trim().toLowerCase();
    if (
      last === "5 hour" ||
      last === "5-hour" ||
      last === "five hour" ||
      last === "weekly" ||
      last === "rolling" ||
      last.includes("limit")
    ) {
      displayLabel = `${prefix} · Remaining Limit`;
    }
  } else if (lower.endsWith(" weekly") && lower !== "weekly") {
    displayLabel = `${cleanModelPrefix(window.label.slice(0, -7).trim())} · Remaining Limit`;
  } else if ((lower.endsWith(" 5 hour") || lower.endsWith(" 5-hour")) && lower !== "5 hour" && lower !== "5-hour") {
    displayLabel = `${cleanModelPrefix(window.label.slice(0, -7).trim())} · Remaining Limit`;
  } else if (
    lower === "weekly" ||
    lower === "5 hour" ||
    lower === "5-hour" ||
    lower === "five hour" ||
    lower === "five_hour" ||
    lower === "rolling" ||
    lower === "five hour limit remaining" ||
    lower === "weekly limit remaining" ||
    lower === "5 hour limit remaining" ||
    lower === "5-hour limit remaining" ||
    lower === "limit remaining" ||
    lower === "usage"
  ) {
    displayLabel = "Remaining Limit";
  }

  return (
    <div className="usage-block">
      <div className="usage-heading">
        <div>
          <span className="usage-label">{displayLabel}</span>
          <strong>{remaining == null ? "Unavailable" : `${Math.round(remaining)}% remaining`}</strong>
        </div>
        {window.windowSeconds ? <span className={`window-pill ${pillClass}`}>{Math.round(window.windowSeconds / 3600)}h window</span> : null}
      </div>
      <div className="progress-track" aria-label={`${window.label} remaining`}>
        <span className={`progress-fill ${tone}`} style={{ width: `${width}%` }} />
      </div>
      <span className="reset-label">{formatReset(window.resetsAt)}</span>
    </div>
  );
}
