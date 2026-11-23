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
 * A limit a saved reset clears.
 */
export type ResetTarget = "five_hour" | "weekly" | "fable_weekly" | "other";

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
  /**
   * The limits using it clears, in the order the advice names them. Empty when the provider
   * does not say which (a rate limit, an unknown grant), and on snapshots saved before this
   * field until the next refresh.
   */
  clears: Array<ResetTarget>,
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

export type LongWindow = "weekly" | "monthly" | "monthly_by_plan";

/**
 * Indexes into the account's `lastUsage.windows`, best first.
 */
export type Headline = {
  /**
   * The 5-hour windows. The meter shows the first that has not reset yet, even without a value.
   */
  fiveHour: Array<number>,
  /**
   * The 7-day windows, then the 30-day ones. The meter shows the first that has not reset yet
   * and has a value.
   */
  long: Array<number>,
  /**
   * What the long meter measures for this account, for its label.
   */
  longWindow: LongWindow | null,
};

/**
 * An account: its stored fields, then what the backend works out from them.
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
  /**
   * Included in the scheduled refresh (not when it must sign in again, or a Google key without
   * Cloud usage).
   */
  autoRefresh: boolean,
  /**
   * The windows the sidebar's meters read.
   */
  headline: Headline,
  /**
   * The plan as the app shows it ("Max/$100"), worked out from `plan`; `null` to show none.
   */
  planDisplay: string | null,
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
    /**
     * A sentence for the person: see [`failure`].
     */
    error: CommandError,
  }
};

export type StartupIssue = {
  message: string,
  /**
   * Where the app keeps its saved data, so the user can look at it.
   */
  dataDir: string | null,
};

/**
 * A QR code: `size` × `size` modules, row by row, `'1'` for a dark one and `'0'` for a light
 * one. The quiet zone around the code is not included; whoever draws it adds that.
 */
export type QrMatrix = {
  size: number,
  modules: string,
};

export type AirgapExportFrame = {
  chunkIndex: number,
  totalChunks: number,
  uri: string,
  /**
   * The frame's QR code: `uri`, as the modules the sender draws.
   */
  qr: QrMatrix,
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

/**
 * A request the sender opened, shown before its user agrees to answer it.
 */
export type FileRequestInfo = {
  /**
   * The accounts this device would send. An account with no saved sign-in is left out of the
   * export, so the reply may hold fewer.
   */
  accountCount: number,
};

/**
 * What an opened reply holds, shown before the user agrees to add it.
 */
export type FilePreview = {
  accountCount: number,
  /**
   * One-time ticket for importing exactly this reply.
   */
  ticket: string,
};

/**
 * A transfer file tapped in another app (Android's Quick Share notification), opened as what
 * its header says it is: a request on the sending device, a reply on the receiving one.
 */
export type TappedFile = {
  "kind": "request",
  info: FileRequestInfo,
} | {
  "kind": "reply",
  preview: FilePreview,
};

/**
 * What kind of failure a command reports. The frontend picks its wording by this, and never
 * adds codes of its own.
 */
export type ErrorCode = "invalid" | "not_found" | "login_in_progress" | "login_attempt_gone" | "auth_required" | "rate_limited" | "network" | "provider" | "storage" | "pairing" | "cancelled" | "unsupported" | "internal" | "unclassified";

export type CommandError = {
  code: ErrorCode,
  /**
   * A plain sentence for the person. Never raw provider, IO or serde text: caller-supplied
   * detail goes through `diagnostics::command_error` first.
   */
  message: string,
};
