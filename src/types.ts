export type Provider = "openai" | "anthropic" | "antigravity" | "google_ai_studio" | "grok" | "opencode_go";

export type UsageFreshness = "live" | "stale" | "unavailable" | "auth_required";

/** What a usage window measures; the backend works it out once (`WindowKind` in `model.rs`). */
export type WindowKind = "five_hour" | "weekly" | "monthly";

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowSeconds: number | null;
  /** `null` when it is none of the three kinds. */
  kind: WindowKind | null;
}

export interface UsageSnapshot {
  plan: string | null;
  email: string | null;
  windows: UsageWindow[];
  creditsUsd: number | null;
  unlimitedCredits: boolean;
  fetchedAt: string;
  freshness: UsageFreshness;
  source: string;
}

export interface Account {
  id: string;
  label: string;
  provider: Provider;
  email: string | null;
  providerAccountId: string | null;
  chatgptAccountId: string | null;
  plan: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsage: UsageSnapshot | null;
  lastError: string | null;
  authRequired: boolean;
}

export interface UsageAlertSetting {
  windowId: "five_hour" | "weekly" | "monthly";
  enabled: boolean;
  thresholdPercent: number;
}

export interface BridgeStatus {
  endpoint: string;
  enabled: boolean;
  running: boolean;
  error: string | null;
}

export interface BridgeInfo extends BridgeStatus {
  /** Masked token (first4••••last4). Full value only via revealBridgeToken(). */
  token: string;
  tokenLast4: string;
}

export interface AccountBucket {
  id: string;
  name: string;
  provider: Provider | null;
  accountIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSnapshot {
  accounts: Account[];
  buckets: AccountBucket[];
  bridge: BridgeStatus;
  /** Saved sign-ins still stored unencrypted (Android); 0 when all are protected. */
  unprotectedCredentials: number;
  /** Accounts whose saved sign-in is still a plain file because locking it failed. */
  unprotectedAccountIds?: string[];
}

/** How well a day of weekly activity is known; the backend works it out (`DayQuality` in `history/activity.rs`). */
export type ActivityQuality = "measured" | "approximate" | "none";

export interface ActivityDay {
  /** Percent of the weekly limit used that day; `null` when nothing was observed (`quality` is `"none"`). */
  usedPercent: number | null;
  quality: ActivityQuality;
}

/** One weekly limit of one account, with one entry per requested day. */
export interface ActivityTracker {
  accountId: string;
  windowId: string;
  windowLabel: string;
  currentUsedPercent: number | null;
  resetsAt: string | null;
  days: ActivityDay[];
  /** Weekly resets inside the range, as RFC 3339 instants. */
  resets: string[];
}

/** What an account without a weekly limit has instead. */
export type OtherLimit = "five_hour" | "daily" | "per_minute" | "monthly" | "other";

export interface UntrackedAccount {
  accountId: string;
  otherLimits: OtherLimit[];
}

export interface WeeklyActivity {
  trackers: ActivityTracker[];
  untracked: UntrackedAccount[];
}

export interface AppSettings {
  accountRefreshMinutes: number;
  paseoBridgeEnabled: boolean;
  automaticUpdatesEnabled: boolean;
  includeBetaUpdates: boolean;
  /** Start the app at login (desktop). */
  autostartEnabled: boolean;
}

export interface LoginStart {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: string;
}

export interface CloudProjectOption {
  projectId: string;
  projectNumber: string;
  displayName: string;
}

export interface LoginStatus {
  attemptId: string;
  status: "waiting" | "complete" | "failed" | "choose_project" | "monitoring_disabled";
  message: string | null;
  account: Account | null;
  projects: CloudProjectOption[] | null;
  selectedProjectId: string | null;
}

export interface AppUpdateStatus {
  currentVersion: string;
  available: boolean;
  availableVersion: string | null;
  date: string | null;
  body: string | null;
  /** Set when the backend check failed. `available` is always false in that case. */
  error: string | null;
}

export type UpdateBusy = "checking" | "downloading" | "verifying" | "installing" | null;

export interface AppUpdateProgress {
  phase: "downloading" | "verifying" | "installing";
  downloaded: number;
  total: number | null;
  percent: number | null;
}

export interface SyncSummary {
  added: number;
  updated: number;
  skipped: number;
  /** Parts of the transfer this device could not save (fixed sentences from the backend). */
  warnings: string[];
}

export interface PairingHostInit {
  sessionId: string;
  qrSvg: string;
  qrUri: string;
  fingerprint: string;
  joinCode: string;
  expiresAt: number;
}


export type PairingStatus =
  | { status: "idle" }
  | {
      status: "hostWaiting" | "receiverWaiting";
      data: {
        sessionId: string;
        qrSvg: string;
        qrUri: string;
        fingerprint: string;
        joinCode: string;
        expiresAt: number;
      };
    }
  | {
      status: "clientConnecting" | "senderConnecting";
      data: {
        sessionId: string;
      };
    }
  | {
      status: "peerConnected";
      data: {
        sessionId: string;
        fingerprint: string;
        sasCode: string;
      };
    }
  | {
      status: "roleSelection";
      data: {
        sessionId: string;
        fingerprint: string;
        sasCode: string;
      };
    }
  | {
      status: "sasVerification";
      data: {
        sessionId: string;
        sasCode: string;
        fingerprint: string;
        role: "receiver" | "sender";
        accountCount?: number | null;
      };
    }
  | {
      status: "transferring";
      data: {
        sessionId: string;
      };
    }
  | {
      status: "completed";
      data: {
        summary: SyncSummary;
      };
    }
  | {
      status: "failed";
      data: {
        error: string;
      };
    };

/** Why the backend could not start, reported instead of the app failing to open. */
export interface StartupIssue {
  message: string;
  /** Where the app keeps its saved data. */
  dataDir: string | null;
}

export interface AirgapExportFrame {
  chunkIndex: number;
  totalChunks: number;
  uri: string;
  svg: string;
}

export interface AirgapExport {
  sessionId: string;
  verifyCode: string;
  totalChunks: number;
  frames: AirgapExportFrame[];
}

export interface AirgapVerifyResult {
  sessionId: string;
  verifyCode: string;
  totalChunks: number;
}
