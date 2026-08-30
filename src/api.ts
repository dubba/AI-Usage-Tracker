import { invoke } from "@tauri-apps/api/core";
import type { Account, AppSettings, AppUpdateStatus, BridgeInfo, BridgeStatus, DashboardSnapshot, LoginStart, LoginStatus, Provider, UsageAlertSetting } from "./types";

export const bridgeApi = {
  snapshot: () => invoke<DashboardSnapshot>("get_dashboard_snapshot"),
  bridgeInfo: () => invoke<BridgeInfo>("get_bridge_info"),
  startLogin: (label: string, provider: Provider) => invoke<LoginStart>("start_login", { label, provider }),
  addOpenCodeGoAccount: (label: string, workspaceId: string, authCookie: string, email?: string) =>
    invoke<Account>("add_opencode_go_account", { label, workspaceId, authCookie, email }),
  testGoogleAiStudioKey: (apiKey: string) =>
    invoke<Account>("probe_google_ai_studio_key", { apiKey }),
  addGoogleAiStudioAccount: (label: string, apiKey: string, selectedModels: string[]) =>
    invoke<Account>("add_google_ai_studio_account", { label, apiKey, selectedModels }),
  startGoogleAiStudioUsageLogin: (accountId: string, projectId: string, enableMonitoring: boolean) =>
    invoke<LoginStart>("start_google_ai_studio_usage_login", { accountId, projectId, enableMonitoring }),
  loginStatus: (attemptId: string) => invoke<LoginStatus>("get_login_status", { attemptId }),
  cancelLogin: (attemptId: string) => invoke<void>("cancel_login", { attemptId }),
  refreshAccount: (accountId: string) => invoke<Account>("refresh_account", { accountId }),
  refreshAll: () => invoke<Account[]>("refresh_all"),
  getAppSettings: () => invoke<AppSettings>("get_app_settings"),
  setAccountRefreshMinutes: (minutes: number) => invoke<AppSettings>("set_account_refresh_minutes", { minutes }),
  setAutomaticUpdatesEnabled: (enabled: boolean) => invoke<AppSettings>("set_automatic_updates_enabled", { enabled }),
  setPaseoBridgeEnabled: (enabled: boolean) => invoke<BridgeStatus>("set_paseo_bridge_enabled", { enabled }),
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
