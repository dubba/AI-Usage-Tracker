import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installSidebarResize } from "./sidebar-resize";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

installSidebarResize();
