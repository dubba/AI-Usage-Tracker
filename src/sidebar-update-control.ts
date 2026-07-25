import { bridgeApi } from "./api";
import type { AppUpdateStatus } from "./types";

const DEFAULT_LABEL = "Check for updates";
const RESET_LABEL_DELAY_MS = 3_000;

function setLabel(footer: HTMLElement, label: string): void {
  footer.dataset.updateLabel = label;
  footer.setAttribute("aria-label", label);
}

export function installSidebarUpdateControl(): void {
  const attach = (): boolean => {
    const footer = document.querySelector<HTMLElement>(".sidebar-footer");
    if (!footer) return false;
    if (footer.dataset.updateControl === "true") return true;

    footer.dataset.updateControl = "true";
    footer.tabIndex = 0;
    footer.setAttribute("role", "button");
    setLabel(footer, DEFAULT_LABEL);

    let busy = false;
    let availableUpdate: AppUpdateStatus | null = null;
    let resetTimer: number | null = null;

    const clearResetTimer = () => {
      if (resetTimer == null) return;
      window.clearTimeout(resetTimer);
      resetTimer = null;
    };

    const restoreDefaultLater = () => {
      clearResetTimer();
      resetTimer = window.setTimeout(() => {
        if (!availableUpdate?.available) setLabel(footer, DEFAULT_LABEL);
      }, RESET_LABEL_DELAY_MS);
    };

    const activate = async () => {
      if (busy) return;
      clearResetTimer();
      busy = true;
      footer.setAttribute("aria-busy", "true");

      try {
        if (availableUpdate?.available) {
          setLabel(footer, "Installing update…");
          await bridgeApi.installUpdate();
          return;
        }

        setLabel(footer, "Checking…");
        const status = await bridgeApi.checkForUpdate();
        availableUpdate = status;
        if (status.available && status.availableVersion) {
          setLabel(footer, `Install v${status.availableVersion}`);
        } else {
          setLabel(footer, "You’re up to date");
          restoreDefaultLater();
        }
      } catch (cause) {
        availableUpdate = null;
        setLabel(footer, "Update check failed");
        footer.title = String(cause);
        restoreDefaultLater();
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
