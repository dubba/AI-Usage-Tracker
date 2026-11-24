import { invoke } from "@tauri-apps/api/core";
import { logIgnored } from "./log";
import { storageGet, storageRemove, storageSet, STORAGE_KEYS } from "./storage";
import type { Account, AccountBucket, AirgapExport, AirgapPreview, AppSettings, FilePreview, IncomingWatchInfo, AppUpdateStatus, BridgeInfo, BridgeStatus, DashboardSnapshot, LoginStart, LoginStatus, PairingHostInit, PairingStatus, Provider, StartupIssue, SyncSummary, UsageAlertSetting, WeeklyActivity } from "../../types";

export function rememberLoginAttempt(attemptId: string) {
  storageSet(STORAGE_KEYS.loginAttempt, attemptId, "session");
}

export function clearLoginAttempt() {
  storageRemove(STORAGE_KEYS.loginAttempt, "session");
}

export function readLoginAttempt(): string | null {
  return storageGet(STORAGE_KEYS.loginAttempt, "session");
}

export const bridgeApi = {
  getDiagnostics: () => invoke<string>("get_diagnostics"),
  getStartupIssue: () => invoke<StartupIssue | null>("get_startup_issue"),
  retryStartup: () => invoke<StartupIssue | null>("retry_startup"),
  snapshot: () => invoke<DashboardSnapshot>("get_dashboard_snapshot"),
  bridgeInfo: () => invoke<BridgeInfo>("get_bridge_info"),
  startLogin: (label: string, provider: Provider, email?: string, reconnectAccountId?: string) =>
    invoke<LoginStart>("start_login", {
      label,
      provider,
      email: email ?? null,
      reconnectAccountId: reconnectAccountId ?? null,
    }),
  addOpenCodeGoAccount: (
    label: string,
    workspaceId: string,
    authCookie: string,
    email?: string,
    reconnectAccountId?: string,
  ) =>
    invoke<Account>("add_opencode_go_account", {
      label,
      workspaceId,
      authCookie,
      email,
      reconnectAccountId: reconnectAccountId ?? null,
    }),
  addGrokAccount: (label: string, cookieHeader: string, reconnectAccountId?: string) =>
    invoke<Account>("add_grok_account", {
      label,
      cookieHeader,
      reconnectAccountId: reconnectAccountId ?? null,
    }),
  testGoogleAiStudioKey: (apiKey: string) =>
    invoke<Account>("probe_google_ai_studio_key", { apiKey }),
  addGoogleAiStudioAccount: (label: string, apiKey: string, selectedModels: string[]) =>
    invoke<Account>("add_google_ai_studio_account", { label, apiKey, selectedModels }),
  startGoogleAiStudioUsageLogin: (accountId: string, projectId: string, enableMonitoring: boolean) =>
    invoke<LoginStart>("start_google_ai_studio_usage_login", { accountId, projectId, enableMonitoring }),
  loginStatus: (attemptId: string) => invoke<LoginStatus>("get_login_status", { attemptId }),
  currentLoginStatus: () => invoke<LoginStatus | null>("current_login_status"),
  cancelLogin: (attemptId: string) => invoke<void>("cancel_login", { attemptId }),
  refreshAccount: (accountId: string) => invoke<Account>("refresh_account", { accountId }),
  useLimitReset: (accountId: string, grantId: string) =>
    invoke<Account>("use_limit_reset", { accountId, grantId }),
  refreshAll: () => invoke<Account[]>("refresh_all"),
  /** Refreshes every account if one is a refresh interval old; true when it refreshed. */
  refreshIfDue: () => invoke<boolean>("refresh_if_due"),
  getAppSettings: () => invoke<AppSettings>("get_app_settings"),
  setAccountRefreshMinutes: (minutes: number) => invoke<AppSettings>("set_account_refresh_minutes", { minutes }),
  setAutomaticUpdatesEnabled: (enabled: boolean) => invoke<AppSettings>("set_automatic_updates_enabled", { enabled }),
  setIncludeBetaUpdates: (enabled: boolean) => invoke<AppSettings>("set_include_beta_updates", { enabled }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<boolean>("set_autostart", { enabled }),
  /** Drops every account's saved usage snapshot; accounts and sign-ins stay. */
  clearCachedUsage: () => invoke<void>("clear_cached_usage"),
  /** Deletes accounts, saved sign-ins, snapshots, groups, alerts, usage history and settings from this device. */
  deleteAllLocalData: () => invoke<void>("delete_all_local_data"),
  /**
   * Weekly usage per day. `dayStarts` are the local midnights of the days to show plus the one
   * after the last, as RFC 3339 instants (N days need N + 1 values).
   */
  getWeeklyActivity: (dayStarts: string[]) => invoke<WeeklyActivity>("get_weekly_activity", { dayStarts }),
  /** Deletes the recorded weekly readings of every account; accounts and current usage stay. */
  clearActivityHistory: () => invoke<void>("clear_activity_history"),
  setApiIntegrationEnabled: (enabled: boolean) => invoke<BridgeStatus>("set_api_integration_enabled", { enabled }),
  openApiIntegrationWindow: () => invoke<void>("open_api_integration_window"),
  reorderAccounts: (accountIds: string[]) => invoke<Account[]>("reorder_accounts", { accountIds }),
  getAccountAlerts: (accountId: string) => invoke<UsageAlertSetting[]>("get_account_alerts", { accountId }),
  saveAccountAlerts: (accountId: string, settings: UsageAlertSetting[]) =>
    invoke<UsageAlertSetting[]>("save_account_alerts", { accountId, settings }),
  saveBucket: (name: string, provider: Provider | null, accountIds: string[], id?: string) =>
    invoke<AccountBucket>("save_account_bucket", { id: id ?? null, name, provider, accountIds }),
  deleteBucket: (id: string) => invoke<void>("delete_account_bucket", { id }),
  renameAccount: (accountId: string, label: string) =>
    invoke<Account>("rename_account", { accountId, label }),
  removeAccount: (accountId: string) => invoke<void>("remove_account", { accountId }),
  /** Removes the accounts whose saved sign-in could not be encrypted; resolves to their ids. */
  removeUnprotectedAccounts: () => invoke<string[]>("remove_unprotected_accounts"),
  regenerateToken: () => invoke<BridgeInfo>("regenerate_bridge_token"),
  revealBridgeToken: () => invoke<string>("reveal_bridge_token"),
  checkForUpdate: (notify = true) => invoke<AppUpdateStatus>("check_for_app_update", { notify }),
  installUpdate: () => invoke<void>("install_app_update"),
  getPendingUpdateNotice: () => invoke<string | null>("get_pending_update_notice"),
};

export const pairingApi = {
  ensureCameraPermission: () => invoke<void>("ensure_camera_permission"),
  /** Whether the phone is on Wi-Fi; Rust records it in the Sync Devices log. */
  wifiEnabled: () => invoke<boolean>("pairing_wifi_enabled"),
  /**
   * Shows a twelve-letter link code, or six digits for a device with an older version (`legacyCode`,
   * Wi-Fi only). `acceptSettings`: this device's "Also Sync Settings and Layout" choice, used if
   * it receives.
   */
  startHost: (acceptSettings: boolean, legacyCode = false) =>
    invoke<PairingHostInit>("pairing_start_host", { acceptSettings, legacyCode }),
  startClientByCode: (code: string, acceptSettings: boolean) =>
    invoke<void>("pairing_start_client_by_code", { code, acceptSettings }),
  selectRole: (role: "send" | "receive") => invoke<void>("pairing_select_role", { role }),
  confirmTransfer: (sessionId: string, confirmed: boolean) =>
    invoke<void>("pairing_confirm_transfer", { sessionId, confirmed }),
  cancel: () => invoke<void>("pairing_cancel"),
  status: () => invoke<PairingStatus>("pairing_status"),
  setIncludeSettings: (include: boolean) =>
    invoke<void>("pairing_set_include_settings", { include }),
  setPendingUiState: (uiState: Record<string, unknown>) =>
    invoke<void>("pairing_set_pending_ui_state", { uiState }),
  clearPendingUiState: () => invoke<void>("pairing_clear_pending_ui_state"),
  prepareAirgapExport: (includeSettings: boolean, uiState?: Record<string, unknown>) =>
    invoke<AirgapExport>("pairing_prepare_airgap_export", {
      includeSettings,
      uiState: uiState ?? null,
    }),
  /** Opens a complete capture and says how many accounts it holds; imports nothing. */
  previewAirgapFrames: (chunks: string[]) =>
    invoke<AirgapPreview>("pairing_verify_airgap", { chunks }),
  /** Imports the frames a preview checked, with the ticket that preview returned (used once). */
  importAirgapFrames: (chunks: string[], ticket: string, acceptSettings: boolean) =>
    invoke<SyncSummary>("pairing_import_airgap", { chunks, ticket, acceptSettings }),
  // Transfer by file. Rust shows the native menus and dialogs and reads and writes the files; an
  // open or save resolves to null or false when the user cancels its dialog.
  /**
   * Sender: makes the file of accounts for the device showing `code` and stops looking for it on
   * the network. Resolves to whether a share menu exists.
   */
  sendFile: (code: string, includeSettings: boolean, uiState?: Record<string, unknown>) =>
    invoke<boolean>("pairing_file_send", { code, includeSettings, uiState: uiState ?? null }),
  /** Opens the system share menu for the file made last. */
  shareFile: () => invoke<void>("pairing_file_share"),
  /** Saves a copy of the file made last where the user chooses. */
  saveFile: () => invoke<boolean>("pairing_file_save"),
  /** Receiver: opens a file with the code this device shows and counts its accounts; imports nothing. */
  openFile: () => invoke<FilePreview | null>("pairing_file_open"),
  /** Android and iPhone: whether a transfer file was opened from another app and not opened here yet. */
  tappedFilePending: () => invoke<boolean>("pairing_file_tapped_pending"),
  /** Android and iPhone: opens that file as `openFile` does; null when none waits. */
  openTappedFile: () => invoke<FilePreview | null>("pairing_file_open_tapped"),
  /**
   * Receiver: starts looking in Downloads for the file (where AirDrop and Quick Share save it);
   * files already there are left alone. Android needs file access first.
   */
  watchForFile: () => invoke<IncomingWatchInfo>("pairing_file_watch"),
  stopWatchingForFile: () => invoke<void>("pairing_file_watch_stop"),
  /** The file that arrived since `watchForFile`, opened; null while none has. */
  pollForFile: () => invoke<FilePreview | null>("pairing_file_poll"),
  /** Android: opens the system page that allows file access, for `watchForFile`. */
  requestFileAccess: () => invoke<void>("pairing_file_request_access"),
  /**
   * Opens who may send this device files by AirDrop or Quick Share: Quick Share's settings on
   * Android, the AirDrop window on a Mac, Nearby sharing on Windows. Does nothing on iPhone.
   */
  openReceiveSettings: () => invoke<void>("pairing_open_receive_settings"),
  /** Receiver: imports the opened file, with the ticket opening it gave. */
  importFile: (ticket: string, acceptSettings: boolean) =>
    invoke<SyncSummary>("pairing_file_import", { ticket, acceptSettings }),
};

/** Best-effort cancel: the user is already leaving the flow, so a failure is logged rather than shown. */
export function cancelPairing(): void {
  void pairingApi.cancel().catch((cause) => logIgnored("pairing.cancel", cause));
}
