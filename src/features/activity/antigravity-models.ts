import type { ActivityTracker } from "../../types";

/** Usage-card names. Account chips keep their own shorter labels. */
const ANTIGRAVITY_FAMILY_NAMES: Record<string, string> = {
  "claude and gpt models": "Other Models",
  "claude & gpt models": "Other Models",
  "other models": "Other Models",
  "gemini 4 argon": "Argon Models",
  "gemini 4 carbon": "Carbon Models",
};

/** "Gemini Models · Weekly Limit Remaining" -> "Gemini Models". A name with no family stays whole. */
export function antigravityFamilyLabel(windowLabel: string): string {
  const splitAt = windowLabel.indexOf(" · ");
  const family = (splitAt <= 0 ? windowLabel : windowLabel.slice(0, splitAt)).trim();
  return ANTIGRAVITY_FAMILY_NAMES[family.toLowerCase()] ?? family;
}

function antigravityModelRank(tracker: ActivityTracker): number {
  const family = antigravityFamilyLabel(tracker.windowLabel).toLowerCase();
  const id = tracker.windowId.toLowerCase();
  if (
    family === "gemini models"
    || family === "gemini"
    || (family.includes("gemini") && !family.includes("argon") && !family.includes("carbon"))
  ) {
    return 0;
  }
  if (
    family === "other models"
    || family === "other"
    || family === "claude & gpt models"
    || family.includes("claude")
    || family.includes("gpt")
    || id.includes("claude")
    || id.includes("gpt")
  ) {
    return 1;
  }
  if (family === "argon models" || family.includes("argon") || id.includes("argon")) {
    return 2;
  }
  if (family === "carbon models" || family.includes("carbon") || id.includes("carbon")) {
    return 3;
  }
  return 4;
}

/** Displays Antigravity model groups in canonical order: Gemini, Claude & GPT, Argon, then any others. */
export function sortAntigravityTrackers(trackers: readonly ActivityTracker[]): ActivityTracker[] {
  return [...trackers].sort((left, right) => antigravityModelRank(left) - antigravityModelRank(right));
}
