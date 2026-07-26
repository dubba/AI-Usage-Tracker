import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PaseoBridgeWindow } from "./PaseoBridgeWindow";
import { installDashboardSummaryPolish } from "./dashboard-summary-polish";
import { installSidebarResize } from "./sidebar-resize";
import { installSidebarUpdateControl } from "./sidebar-update-control";
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

const isPaseoBridgeWindow = getCurrentWindow().label === "paseo-bridge";
document.documentElement.classList.toggle("paseo-bridge-window-root", isPaseoBridgeWindow);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isPaseoBridgeWindow ? <PaseoBridgeWindow /> : <App />}
  </StrictMode>,
);

if (!isPaseoBridgeWindow) {
  installSidebarResize();
  installSidebarUpdateControl();
  installDashboardSummaryPolish();
}
