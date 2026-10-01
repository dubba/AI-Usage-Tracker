import "../styles/tokens.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ApiIntegrationWindow } from "../features/api-integration/ApiIntegrationWindow";
import { StartupGate } from "../features/startup/StartupGate";
import { LEGACY_STORAGE, storageKeys, storageRemove } from "../shared/lib/storage";
import "../styles/base.css";
import "../styles/shell-patches.css";
import "../styles/api-integration.css";
import "../styles/obsidian-dashboard.css";
import "../styles/ui-refinements.css";
import "../styles/dashboard-reorder.css";
import "../styles/modal-close.css";
import "../styles/account-card-responsive.css";

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
storageRemove(LEGACY_STORAGE.opencodeAccountEmails);
for (const key of storageKeys(LEGACY_STORAGE.accountEmailPrefix)) storageRemove(key);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isApiIntegrationWindow ? (
      <ApiIntegrationWindow />
    ) : (
      <StartupGate>
        <App />
      </StartupGate>
    )}
  </StrictMode>,
);

