import { openUrl } from "@tauri-apps/plugin-opener";
import { bridgeApi } from "./api";
import type { AppUpdateStatus } from "./types";

export const APP_UPDATE_STATUS_EVENT = "ai-subscription-tracker:app-update-status";

const DEFAULT_LABEL = "Check for App Updates";
const CHANGELOG_URL = "https://github.com/yajinni/AI-Subscription-Tracker/blob/main/CHANGELOG.md";
const RESET_LABEL_DELAY_MS = 3_000;

export function publishAppUpdateStatus(status: AppUpdateStatus): void {
  window.dispatchEvent(new CustomEvent<AppUpdateStatus>(APP_UPDATE_STATUS_EVENT, { detail: status }));
}

function setLabel(footer: HTMLElement, label: string): void {
  footer.dataset.updateLabel = label;
  footer.setAttribute("aria-label", label);
  const visibleLabel = footer.querySelector<HTMLElement>(":scope > span");
  if (visibleLabel) visibleLabel.textContent = label;
}

function installSettingsChangelogControl(): void {
  const attach = () => {
    const settingsHeading = Array.from(document.querySelectorAll<HTMLElement>(".page-header h1"))
      .find((heading) => heading.textContent?.trim() === "Settings");
    const settingsView = settingsHeading?.closest<HTMLElement>(".content-scroll");
    const settingsCard = settingsView?.querySelector<HTMLElement>(".settings-card");
    if (!settingsCard || settingsCard.querySelector("[data-settings-changelog-control='true']")) return;

    const row = document.createElement("div");
    row.className = "settings-row";
    row.dataset.settingsChangelogControl = "true";

    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Change Log";
    const helper = document.createElement("small");
    helper.textContent = "View the full history of user-facing app changes.";
    description.append(title, helper);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "button ghost";
    button.textContent = "View Change Log";
    button.addEventListener("click", () => {
      button.title = "";
      void openUrl(CHANGELOG_URL).catch((cause) => {
        button.title = `Could not open changelog: ${String(cause)}`;
      });
    });

    row.append(description, button);
    settingsCard.append(row);
  };

  attach();
  const observer = new MutationObserver(attach);
  observer.observe(document.body, { childList: true, subtree: true });
}

export function installSidebarUpdateControl(): void {
  installSettingsChangelogControl();

  const attach = (): boolean => {
    const footer = document.querySelector<HTMLElement>(".sidebar-footer");
    if (!footer) return false;
    if (footer.dataset.updateControl === "true") return true;

    footer.dataset.updateControl = "true";
    footer.tabIndex = 0;
    footer.setAttribute("role", "button");
    setLabel(footer, DEFAULT_LABEL);

    const changelogLink = document.createElement("a");
    changelogLink.className = "sidebar-changelog-link";
    changelogLink.href = CHANGELOG_URL;
    changelogLink.target = "_blank";
    changelogLink.rel = "noreferrer";
    changelogLink.textContent = "View Change Log";
    changelogLink.hidden = true;
    footer.insertAdjacentElement("afterend", changelogLink);

    let busy = false;
    let availableUpdate: AppUpdateStatus | null = null;
    let resetTimer: number | null = null;

    const clearResetTimer = () => {
      if (resetTimer == null) return;
      window.clearTimeout(resetTimer);
      resetTimer = null;
    };

    const setAvailableState = (available: boolean) => {
      footer.classList.toggle("update-available", available);
      changelogLink.hidden = !available;
    };

    const applyStatus = (status: AppUpdateStatus) => {
      availableUpdate = status;
      if (status.available && status.availableVersion) {
        setAvailableState(true);
        setLabel(footer, `Update to v${status.availableVersion}`);
      } else {
        setAvailableState(false);
        setLabel(footer, DEFAULT_LABEL);
      }
    };

    const restoreCurrentStateLater = () => {
      clearResetTimer();
      resetTimer = window.setTimeout(() => {
        if (availableUpdate) applyStatus(availableUpdate);
        else setLabel(footer, DEFAULT_LABEL);
      }, RESET_LABEL_DELAY_MS);
    };

    const syncAutomaticStatus = (event: Event) => {
      const status = (event as CustomEvent<AppUpdateStatus>).detail;
      if (status) applyStatus(status);
    };
    window.addEventListener(APP_UPDATE_STATUS_EVENT, syncAutomaticStatus);

    changelogLink.addEventListener("click", (event) => {
      event.preventDefault();
      void openUrl(CHANGELOG_URL).catch((cause) => {
        footer.title = `Could not open changelog: ${String(cause)}`;
      });
    });

    const activate = async () => {
      if (busy) return;
      clearResetTimer();
      busy = true;
      footer.setAttribute("aria-busy", "true");
      footer.title = "";

      try {
        if (availableUpdate?.available) {
          setLabel(footer, "Installing update…");
          await bridgeApi.installUpdate();
          return;
        }

        setLabel(footer, "Checking…");
        const status = await bridgeApi.checkForUpdate();
        publishAppUpdateStatus(status);
        if (!status.available) {
          setLabel(footer, "You’re up to date");
          restoreCurrentStateLater();
        }
      } catch (cause) {
        const updateWasAvailable = Boolean(availableUpdate?.available);
        if (!updateWasAvailable) {
          availableUpdate = null;
          setAvailableState(false);
        }
        setLabel(footer, updateWasAvailable ? "Update install failed" : "Update check failed");
        footer.title = String(cause);
        restoreCurrentStateLater();
      } finally {
        busy = false;
        footer.removeAttribute("aria-busy");
      }
    };

    footer.addEventListener("click", () => void activate());
    footer.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void activate();
    });
    return true;
  };

  if (attach()) return;
  const observer = new MutationObserver(() => {
    if (attach()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
