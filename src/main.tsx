import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PaseoBridgeWindow } from "./PaseoBridgeWindow";
import { installDashboardReorder } from "./dashboard-reorder";
import { installSidebarResize } from "./sidebar-resize";
import { installSidebarUpdateControl } from "./sidebar-update-control";
import { installUiRefinements } from "./ui-refinements";
import "./styles.css";
import "./updater.css";
import "./provider.css";
import "./readability.css";
import "./dashboard-layout.css";
import "./sidebar-controls.css";
import "./sidebar-width.css";
import "./macos-account-actions.css";
import "./provider-icon-fixes.css";
import "./sidebar-resize.css";
import "./dashboard-typography.css";
import "./app-shell-polish.css";
import "./paseo-bridge.css";
import "./obsidian-dashboard.css";
import "./ui-refinements.css";
import "./dashboard-reorder.css";
import "./modal-close.css";
import "./account-card-responsive.css";

const isPaseoBridgeWindow = getCurrentWindow().label === "paseo-bridge";
document.documentElement.classList.toggle("paseo-bridge-window-root", isPaseoBridgeWindow);

// One-time removal of legacy localStorage account emails, now stored in the backend.
try {
  window.localStorage.removeItem("ai-subscription-tracker:opencode-account-emails");
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith("paseo-usage-bridge:account-email:")) window.localStorage.removeItem(key);
  }
} catch {
  // WebView storage may be unavailable; nothing critical depends on the cleanup.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isPaseoBridgeWindow ? <PaseoBridgeWindow /> : <App />}
  </StrictMode>,
);

if (!isPaseoBridgeWindow) {
  installSidebarResize();
  installSidebarUpdateControl();
  installUiRefinements();
  installDashboardReorder();
}
