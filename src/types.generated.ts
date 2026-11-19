// Generated from the Rust types by `src-tauri/src/type_contract.rs`. Do not edit.
// Rewrite with `UPDATE_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --lib type_contract`.

export type Provider = "openai" | "anthropic" | "antigravity" | "google_ai_studio" | "grok" | "opencode_go";

export type UsageFreshness = "live" | "stale" | "unavailable" | "auth_required";

/**
 * What a usage window measures. Providers name their windows in their own words (ids such as
 * `five_hour_2`, labels such as "Gemini models · 7-Day Limit"); this is the one place that turns
 * those into the three kinds the app has alerts, sidebar slots and styling for.
 */
export type WindowKind = "five_hour" | "weekly" | "monthly";

export type UsageWindow = {
  id: string,
  label: string,
  usedPercent: number | null,
  remainingPercent: number | null,
  resetsAt: string | null,
  windowSeconds: number | null,
  /**
   * Worked out from the fields above by [`WindowKind::classify`] wherever usage enters the app
   * (a refresh, the account file, a pairing import), never read from a provider. Providers leave
   * it `None`. It is for the app's own commands; the local API does not publish it.
   */
  kind: WindowKind | null,
};

/**
 * One saved limit reset the provider has offered. Spending it is a separate,
 * confirmed action. `id` is the provider's redeem id when `usable` is true.
 * A display-only row uses an id this app made, and the provider's spend id
 * is never stored.
 */
export type LimitReset = {
  id: string,
  label: string,
  detail: string,
  expiresAt: string | null,
  /**
   * Missing on snapshots saved before this field. Those grants can be used.
   */
  usable: boolean,
};

export type UsageSnapshot = {
  plan: string | null,
  email: string | null,
  windows: Array<UsageWindow>,
  creditsUsd: number | null,
  unlimitedCredits: boolean,
  fetchedAt: string,
  freshness: UsageFreshness,
  source: string,
  /**
   * Empty when this account has nothing to spend. Missing on older snapshots.
   */
  limitResets: Array<LimitReset>,
};

/**
 * The one state an account's card reports, worst first: the first that applies wins.
 */
export type AccountHealth = "signed_out" | "out_of_date" | "refresh_failed" | "key_only" | "setup" | "inactive" | "live";

/**
 * How far a Google AI Studio account's Cloud usage setup has got, from its last usage.
 */
export type GoogleSetup = "key_only" | "waiting" | "ready" | "unknown";

/**
 * An account: its stored fields, then the health and Google setup the backend works out from them.
 */
export type Account = {
  id: string,
  label: string,
  provider: Provider,
  email: string | null,
  providerAccountId: string | null,
  chatgptAccountId: string | null,
  plan: string | null,
  createdAt: string,
  updatedAt: string,
  lastUsage: UsageSnapshot | null,
  lastError: string | null,
  authRequired: boolean,
  health: AccountHealth,
  /**
   * `null` for an account of another provider.
   */
  googleSetup: GoogleSetup | null,
};

export type UsageAlertSetting = {
  windowId: "five_hour" | "weekly" | "monthly",
  enabled: boolean,
  thresholdPercent: number,
};

export type BridgeStatus = {
  endpoint: string,
  enabled: boolean,
  running: boolean,
  error: string | null,
};

export type BridgeInfo = {
  endpoint: string,
  /**
   * Masked bearer token (e.g. `abcd••••••wxyz`). The full token is never
   * sent over IPC by default; use the explicit `reveal_bridge_token`
   * command after user confirmation to obtain it once.
   */
  token: string,
  tokenLast4: string,
  enabled: boolean,
  running: boolean,
  error: string | null,
};

export type AccountBucket = {
  id: string,
  name: string,
  provider: Provider | null,
  accountIds: Array<string>,
  createdAt: string,
  updatedAt: string,
};

export type DashboardSnapshot = {
  accounts: Array<Account>,
  buckets: Array<AccountBucket>,
  bridge: BridgeStatus,
  /**
   * Saved sign-ins that are still stored unencrypted (Android). The app
   * keeps retrying; the UI warns when this stays above zero.
   */
  unprotectedCredentials: number,
  /**
   * Accounts whose saved sign-in is still a plain file because locking it
   * failed. Empty when every sign-in is locked, and on desktop.
   */
  unprotectedAccountIds: Array<string>,
};

/**
 * How well a day's value is known.
 */
export type ActivityQuality = "measured" | "approximate" | "none";

export type ActivityDay = {
  /**
   * Percent of the weekly limit used that day, or `None` when `quality` is `None`.
   */
  usedPercent: number | null,
  quality: ActivityQuality,
};

export type ActivityTracker = {
  accountId: string,
  windowId: string,
  windowLabel: string,
  /**
   * `weekly`, or `monthly` for an account that has no weekly limit (shown on the 30 day view).
   */
  windowKind: "weekly" | "monthly",
  currentUsedPercent: number | null,
  resetsAt: string | null,
  /**
   * One entry per requested day.
   */
  days: Array<ActivityDay>,
  /**
   * Reset lines inside the range: reset times the provider recorded, plus the one week before
   * a weekly limit's latest reset when that week was not recorded.
   */
  resets: Array<string>,
  /**
   * How full the window was at each reset in `resets`. `None` when that week was not watched.
   */
  resetUsedPercent: Array<number | null>,
};

/**
 * What an account without a weekly limit has instead.
 */
export type OtherLimit = "five_hour" | "daily" | "per_minute" | "monthly" | "other";

/**
 * An account that has no weekly limit to chart.
 */
export type UntrackedAccount = {
  accountId: string,
  otherLimits: Array<OtherLimit>,
};

export type WeeklyActivity = {
  trackers: Array<ActivityTracker>,
  untracked: Array<UntrackedAccount>,
};

export type AppSettings = {
  accountRefreshMinutes: number,
  paseoBridgeEnabled: boolean,
  automaticUpdatesEnabled: boolean,
  includeBetaUpdates: boolean,
  autostartEnabled: boolean,
};

export type LoginStart = {
  attemptId: string,
  authorizationUrl: string,
  expiresAt: string,
};

export type CloudProjectOption = {
  projectId: string,
  projectNumber: string,
  displayName: string,
};

/**
 * Where a sign-in attempt stands. Serialized in snake_case; the frontend's `LoginState` type is
 * generated from this enum.
 */
export type LoginState = "waiting" | "complete" | "failed" | "choose_project" | "monitoring_disabled";

export type LoginStatus = {
  attemptId: string,
  status: LoginState,
  message: string | null,
  account: Account | null,
  projects: Array<CloudProjectOption> | null,
  selectedProjectId: string | null,
};

export type AppUpdateStatus = {
  currentVersion: string,
  available: boolean,
  availableVersion: string | null,
  date: string | null,
  body: string | null,
  /**
   * Set when the check failed. `available` is always false in that case.
   */
  error: string | null,
};

export type AppUpdateProgress = {
  phase: "downloading" | "verifying" | "installing",
  downloaded: number,
  total: number | null,
  percent: number | null,
};

export type SyncSummary = {
  added: number,
  updated: number,
  skipped: number,
  /**
   * Short, fixed sentences about parts of the transfer that could not be saved on this
   * device (never payload contents). Only the importing device fills this in; the
   * sender's summary comes from the 6-byte acknowledgement and has none.
   */
  warnings: Array<string>,
};

export type PairingHostInit = {
  sessionId: string,
  joinCode: string,
  expiresAt: number,
};

export type PairingStatus = {
  "status": "idle"
} | {
  "status": "hostWaiting",
  "data": {
    sessionId: string,
    joinCode: string,
    expiresAt: number,
  }
} | {
  "status": "clientConnecting",
  "data": {
    sessionId: string,
  }
} | {
  "status": "peerConnected",
  "data": {
    sessionId: string,
  }
} | {
  "status": "roleSelection",
  "data": {
    sessionId: string,
  }
} | {
  "status": "confirmTransfer",
  "data": {
    sessionId: string,
    role: "receiver" | "sender",
    accountCount: number | null,
  }
} | {
  "status": "transferring",
  "data": {
    sessionId: string,
  }
} | {
  "status": "completed",
  "data": {
    summary: SyncSummary,
  }
} | {
  "status": "failed",
  "data": {
    error: string,
  }
};

export type StartupIssue = {
  message: string,
  /**
   * Where the app keeps its saved data, so the user can look at it.
   */
  dataDir: string | null,
};

export type AirgapExportFrame = {
  chunkIndex: number,
  totalChunks: number,
  uri: string,
  svg: string,
};

export type AirgapExport = {
  sessionId: string,
  totalChunks: number,
  frames: Array<AirgapExportFrame>,
};

/**
 * What a complete capture holds, shown before the user agrees to import it.
 */
export type AirgapPreview = {
  sessionId: string,
  totalChunks: number,
  /**
   * Accounts in the transfer. Ones this device already has are skipped on import.
   */
  accountCount: number,
  /**
   * One-time ticket for importing exactly these frames. The import must
   * present it with the same frames (L-104).
   */
  ticket: string,
};
