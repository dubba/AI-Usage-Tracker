export type Provider = "openai" | "anthropic" | "antigravity" | "google_ai_studio" | "grok" | "opencode_go";

export type UsageFreshness = "live" | "stale" | "unavailable" | "auth_required";

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowSeconds: number | null;
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
  token: string;
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
}

export interface AppSettings {
  accountRefreshMinutes: number;
  paseoBridgeEnabled: boolean;
  automaticUpdatesEnabled: boolean;
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

export interface SyncSummary {
  added: number;
  updated: number;
  skipped: number;
}

export interface PairingHostInit {
  sessionId: string;
  qrSvg: string;
  qrUri: string;
  fingerprint: string;
  joinCode: string;
  expiresAt: number;
}

export type PairingReceiverInit = PairingHostInit;

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
        accountCount?: number;
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

