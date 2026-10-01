import type {
  UpdateBusy,
} from "../../types";

export function updateProgressLabel(busy: UpdateBusy, percent: number | null): string {
  if (busy === "downloading") {
    return percent != null ? `Downloading… ${percent}%` : "Downloading…";
  }
  if (busy === "verifying") return "Verifying update…";
  if (busy === "installing") return "Opening installer…";
  return "";
}

export function updateInstallLabel(busy: UpdateBusy, percent: number | null): string {
  if (busy === "downloading") {
    return percent != null ? `Downloading ${percent}%` : "Downloading…";
  }
  if (busy === "verifying") return "Verifying…";
  if (busy === "installing") return "Installing…";
  return "Update";
}

export function UpdateProgressBar({ busy, percent }: { busy: UpdateBusy; percent: number | null }) {
  if (busy !== "downloading" && busy !== "verifying" && busy !== "installing") return null;
  const label = updateProgressLabel(busy, percent);
  const determinate = busy === "downloading" && percent != null;
  return (
    <div className="settings-update-progress" role="status" aria-live="polite">
      <span className="settings-update-progress-label">{label}</span>
      <div
        className={`settings-update-progress-track${determinate ? "" : " is-indeterminate"}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent ?? undefined : undefined}
      >
        <div
          className="settings-update-progress-fill"
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}
