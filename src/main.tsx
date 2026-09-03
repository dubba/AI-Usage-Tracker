import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ApiIntegrationWindow } from "./ApiIntegrationWindow";
import { installDashboardReorder } from "./dashboard-reorder";
import { installSidebarResize } from "./sidebar-resize";
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
import "./api-integration.css";
import "./obsidian-dashboard.css";
import "./ui-refinements.css";
import "./dashboard-reorder.css";
import "./modal-close.css";
import "./account-card-responsive.css";

// On Android, getCurrentWindow() may throw because the window plugin metadata
// is not injected the same way as on desktop. There is only one window on
// mobile, so isApiIntegrationWindow is always false on Android.
const API_INTEGRATION_WINDOW_LABEL = "api-integration";
let isApiIntegrationWindow = false;
try {
  isApiIntegrationWindow = getCurrentWindow().label === API_INTEGRATION_WINDOW_LABEL;
} catch {
  // mobile / test environment — no API integration window possible
}
document.documentElement.classList.toggle("api-integration-window-root", isApiIntegrationWindow);

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
    {isApiIntegrationWindow ? <ApiIntegrationWindow /> : <App />}
  </StrictMode>,
);

if (!isApiIntegrationWindow) {
  installSidebarResize();
  installUiRefinements();
  installDashboardReorder();
}
