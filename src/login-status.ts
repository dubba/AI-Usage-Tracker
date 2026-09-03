import { bridgeApi, clearLoginAttempt, readLoginAttempt, rememberLoginAttempt } from "./api";
import type { LoginStatus } from "./types";

export const LOGIN_STATUS_EVENT = "ai-usage-tracker:login-status";

const POLL_MS = 900;

let pollTimer: number | null = null;
let activeAttemptId: string | null = null;
let tickInFlight = false;
let lastStatus: LoginStatus | null = null;

function isTerminal(status: LoginStatus): boolean {
  return status.status === "complete" || status.status === "failed";
}

function stopPolling(): void {
  if (pollTimer == null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

function publishLoginStatus(status: LoginStatus): void {
  lastStatus = status;
  window.dispatchEvent(new CustomEvent<LoginStatus>(LOGIN_STATUS_EVENT, { detail: status }));
}

const RETRYABLE_LOGIN_MESSAGE =
  "Lost connection while waiting for sign-in. Check your network and retry.";

function retryableFailure(attemptId: string): LoginStatus {
  const previous = lastStatus?.attemptId === attemptId ? lastStatus : null;
  return {
    attemptId,
    status: "failed",
    message: RETRYABLE_LOGIN_MESSAGE,
    account: previous?.account ?? null,
    projects: previous?.projects ?? null,
    selectedProjectId: previous?.selectedProjectId ?? null,
  };
}

async function tick(): Promise<void> {
  if (tickInFlight) return;
  const attemptId = activeAttemptId;
  if (!attemptId) {
    stopPolling();
    return;
  }

  tickInFlight = true;
  try {
    const status = await bridgeApi.loginStatus(attemptId);
    if (activeAttemptId !== attemptId) return;
    publishLoginStatus(status);
    if (isTerminal(status)) {
      stopPolling();
      activeAttemptId = null;
      clearLoginAttempt();
    }
  } catch (cause) {
    if (activeAttemptId !== attemptId) return;
    if (String(cause).toLowerCase().includes("no login attempt is available")) {
      stopWatchingLoginAttempt();
      clearLoginAttempt();
      return;
    }
    stopPolling();
    // Keep the attempt id so the modal can Retry without starting a new login.
    publishLoginStatus(retryableFailure(attemptId));
  } finally {
    tickInFlight = false;
  }
}

export function getLastLoginStatus(): LoginStatus | null {
  return lastStatus;
}

export function subscribeLoginStatus(listener: (status: LoginStatus) => void): () => void {
  const handler = (event: Event) => {
    const status = (event as CustomEvent<LoginStatus>).detail;
    if (status) listener(status);
  };
  window.addEventListener(LOGIN_STATUS_EVENT, handler);
  return () => window.removeEventListener(LOGIN_STATUS_EVENT, handler);
}

export function watchLoginAttempt(attemptId: string): void {
  rememberLoginAttempt(attemptId);
  if (activeAttemptId === attemptId && pollTimer != null) return;
  activeAttemptId = attemptId;
  stopPolling();
  void tick();
  pollTimer = window.setInterval(() => void tick(), POLL_MS);
}

export function canResumeLoginAttempt(attemptId: string): boolean {
  return Boolean(attemptId) && (activeAttemptId === attemptId || readLoginAttempt() === attemptId);
}

export function retryLoginAttempt(attemptId: string): boolean {
  if (!canResumeLoginAttempt(attemptId)) return false;
  watchLoginAttempt(attemptId);
  return true;
}

export function stopWatchingLoginAttempt(): void {
  stopPolling();
  activeAttemptId = null;
}

export function abandonLoginAttempt(attemptId: string): void {
  if (activeAttemptId && activeAttemptId !== attemptId) {
    void bridgeApi.cancelLogin(attemptId);
    return;
  }
  stopWatchingLoginAttempt();
  clearLoginAttempt();
  void bridgeApi.cancelLogin(attemptId);
}

export async function recoverFromStaleLogin(): Promise<void> {
  const stored = readLoginAttempt();
  const current = await bridgeApi.currentLoginStatus().catch(() => null);
  const attemptId = current?.attemptId ?? stored;
  if (!attemptId) return;
  stopWatchingLoginAttempt();
  clearLoginAttempt();
  await bridgeApi.cancelLogin(attemptId).catch(() => undefined);
}

export async function resumeLoginAttemptWatch(): Promise<void> {
  if (activeAttemptId || pollTimer != null) return;

  const stored = readLoginAttempt();
  if (stored) {
    watchLoginAttempt(stored);
    return;
  }

  try {
    const current = await bridgeApi.currentLoginStatus();
    if (!current || activeAttemptId || pollTimer != null) return;
    if (current.status === "waiting" || current.status === "choose_project" || current.status === "monitoring_disabled") {
      watchLoginAttempt(current.attemptId);
      return;
    }
    publishLoginStatus(current);
    clearLoginAttempt();
  } catch {
    clearLoginAttempt();
  }
}
