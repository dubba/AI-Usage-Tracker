import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

installSidebarResize();
installSidebarUpdateControl();
installDashboardSummaryPolish();
