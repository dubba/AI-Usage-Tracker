import { invoke } from "@tauri-apps/api/core";
import type { Account, AppSettings, AppUpdateStatus, BridgeInfo, DashboardSnapshot, LoginStart, LoginStatus, Provider, UsageAlertSetting } from "./types";

const GOOGLE_AI_STUDIO_PROBE_WORKSPACE_ID = "google-ai-studio:probe";

function googleAiStudioWorkspaceId(selectedModels: string[]): string {
  return `google-ai-studio:${JSON.stringify({ selectedModels })}`;
}

export const bridgeApi = {
  snapshot: () => invoke<DashboardSnapshot>("get_dashboard_snapshot"),
  startLogin: (label: string, provider: Provider) => invoke<LoginStart>("start_login", { label, provider }),
  addOpenCodeGoAccount: (label: string, workspaceId: string, authCookie: string) =>
    invoke<Account>("add_opencode_go_account", { label, workspaceId, authCookie }),
  testGoogleAiStudioKey: (apiKey: string) =>
    invoke<Account>("add_opencode_go_account", {
      label: "Google AI Studio",
      workspaceId: GOOGLE_AI_STUDIO_PROBE_WORKSPACE_ID,
      authCookie: apiKey,
    }),
  addGoogleAiStudioAccount: (label: string, apiKey: string, selectedModels: string[]) =>
    invoke<Account>("add_opencode_go_account", {
      label,
      workspaceId: googleAiStudioWorkspaceId(selectedModels),
      authCookie: apiKey,
    }),
  loginStatus: (attemptId: string) => invoke<LoginStatus>("get_login_status", { attemptId }),
  refreshAccount: (accountId: string) => invoke<Account>("refresh_account", { accountId }),
  refreshAll: () => invoke<Account[]>("refresh_all"),
  getAppSettings: () => invoke<AppSettings>("get_app_settings"),
  setAccountRefreshMinutes: (minutes: number) => invoke<AppSettings>("set_account_refresh_minutes", { minutes }),
  setPaseoBridgeEnabled: (enabled: boolean) => invoke<BridgeInfo>("set_paseo_bridge_enabled", { enabled }),
  openPaseoBridgeWindow: () => invoke<void>("open_paseo_bridge_window"),
  reorderAccounts: (accountIds: string[]) => invoke<Account[]>("reorder_accounts", { accountIds }),
  getAccountAlerts: (accountId: string) => invoke<UsageAlertSetting[]>("get_account_alerts", { accountId }),
  saveAccountAlerts: (accountId: string, settings: UsageAlertSetting[]) =>
    invoke<UsageAlertSetting[]>("save_account_alerts", { accountId, settings }),
  renameAccount: (accountId: string, label: string) =>
    invoke<Account>("rename_account", { accountId, label }),
  removeAccount: (accountId: string) => invoke<void>("remove_account", { accountId }),
  regenerateToken: () => invoke<BridgeInfo>("regenerate_bridge_token"),
  checkForUpdate: () => invoke<AppUpdateStatus>("check_for_app_update"),
  installUpdate: () => invoke<void>("install_app_update"),
};
