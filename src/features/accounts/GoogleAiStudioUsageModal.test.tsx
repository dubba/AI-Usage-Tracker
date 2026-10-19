// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, CloudProjectOption, LoginStatus } from "../../types";

const api = vi.hoisted(() => ({
  startGoogleAiStudioUsageLogin: vi.fn(),
  cancelLogin: vi.fn(async () => {}),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api, readLoginAttempt: () => null }));

const login = vi.hoisted(() => ({
  listeners: new Set<(status: LoginStatus) => void>(),
  last: null as LoginStatus | null,
  watchLoginAttempt: vi.fn(),
  retryLoginAttempt: vi.fn(() => false),
  abandonLoginAttempt: vi.fn(),
}));
vi.mock("../../shared/lib/login-status", () => ({
  subscribeLoginStatus: (listener: (status: LoginStatus) => void) => {
    login.listeners.add(listener);
    return () => login.listeners.delete(listener);
  },
  getLastLoginStatus: () => login.last,
  watchLoginAttempt: login.watchLoginAttempt,
  retryLoginAttempt: login.retryLoginAttempt,
  abandonLoginAttempt: login.abandonLoginAttempt,
}));

const openSafeUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../shared/lib/safeUrl", () => ({ openSafeUrl }));

import { click, mount, settle, type Mounted } from "../../test-utils/react";
import { GoogleAiStudioUsageModal } from "./GoogleAiStudioUsageModal";

const ACCOUNT = { id: "acc-1", label: "Key", provider: "google_ai_studio" } as unknown as Account;
const PROJECTS: CloudProjectOption[] = [
  { projectId: "p-1", projectNumber: "1", displayName: "Project One" },
  { projectId: "p-2", projectNumber: "2", displayName: "Project Two" },
];

const onClose = vi.fn();
const onConnected = vi.fn();
let mounted: Mounted | null = null;

function render(account: Account | null = ACCOUNT) {
  mounted = mount(<GoogleAiStudioUsageModal account={account} onClose={onClose} onConnected={onConnected} />);
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text)!;
const errorText = () => document.querySelector(".modal-error")?.textContent ?? null;

function emit(status: Partial<LoginStatus> & { attemptId: string; status: LoginStatus["status"] }) {
  const full = { message: null, account: null, projects: null, selectedProjectId: null, ...status } as LoginStatus;
  act(() => {
    for (const listener of [...login.listeners]) listener(full);
  });
}

async function signIn(attemptId = "att-1", authorizationUrl = "https://accounts.google.com/auth") {
  api.startGoogleAiStudioUsageLogin.mockResolvedValue({ attemptId, authorizationUrl, expiresAt: "" });
  click(button("Sign In with Google"));
  await settle();
}

beforeEach(() => {
  login.listeners.clear();
  login.last = null;
  login.watchLoginAttempt.mockClear();
  login.retryLoginAttempt.mockReset().mockReturnValue(false);
  login.abandonLoginAttempt.mockClear();
  api.startGoogleAiStudioUsageLogin.mockReset();
  api.cancelLogin.mockClear();
  openSafeUrl.mockClear();
  onClose.mockClear();
  onConnected.mockClear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("GoogleAiStudioUsageModal", () => {
  it("renders nothing without an account", () => {
    render(null);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("signs in: starts the attempt, opens the Google page and waits for the result", async () => {
    render();
    await signIn();
    expect(api.startGoogleAiStudioUsageLogin).toHaveBeenCalledWith("acc-1", "", false);
    expect(login.watchLoginAttempt).toHaveBeenCalledWith("att-1");
    expect(openSafeUrl).toHaveBeenCalledWith("https://accounts.google.com/auth");
    expect(document.querySelector(".login-status")?.textContent).toContain("Waiting for Google");
    expect(button("Waiting for Google…").disabled).toBe(true);
  });

  it("hands the connected account to the app", async () => {
    render();
    await signIn();
    const connected = { id: "acc-1" } as unknown as Account;
    emit({ attemptId: "att-1", status: "complete", account: connected });
    expect(onConnected).toHaveBeenCalledWith(connected);
  });

  it("ignores the result of another attempt", async () => {
    render();
    await signIn();
    emit({ attemptId: "someone-else", status: "complete", account: ACCOUNT });
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("shows why a sign-in failed and offers Retry, which starts again when nothing can be resumed", async () => {
    render();
    await signIn();
    emit({ attemptId: "att-1", status: "failed", message: "Google refused." });
    expect(errorText()).toBe("Google refused.");
    expect(button("Retry").disabled).toBe(false);
    api.startGoogleAiStudioUsageLogin.mockClear();
    click(button("Retry"));
    await settle();
    expect(api.startGoogleAiStudioUsageLogin).toHaveBeenCalledTimes(1);
  });

  it("Retry resumes the same attempt when it can", async () => {
    render();
    await signIn();
    emit({ attemptId: "att-1", status: "failed", message: "Lost connection." });
    login.retryLoginAttempt.mockReturnValue(true);
    api.startGoogleAiStudioUsageLogin.mockClear();
    click(button("Retry"));
    await settle();
    expect(login.retryLoginAttempt).toHaveBeenCalledWith("att-1");
    expect(api.startGoogleAiStudioUsageLogin).not.toHaveBeenCalled();
    expect(document.querySelector(".login-status")).not.toBeNull();
    expect(errorText()).toBeNull();
  });

  it("asks which project to use, then connects the chosen one", async () => {
    render();
    await signIn();
    emit({ attemptId: "att-1", status: "choose_project", projects: PROJECTS, selectedProjectId: "p-2" });
    expect(document.querySelector("h2")?.textContent).toBe("Choose the API key project");
    api.startGoogleAiStudioUsageLogin.mockResolvedValue({ attemptId: "att-2", authorizationUrl: "", expiresAt: "" });
    click(button("Connect This Project"));
    await settle();
    expect(api.startGoogleAiStudioUsageLogin).toHaveBeenLastCalledWith("acc-1", "p-2", false);
    expect(login.watchLoginAttempt).toHaveBeenCalledWith("att-2");
    // No authorization URL: nothing to open this time.
    expect(openSafeUrl).toHaveBeenCalledTimes(1);
  });

  it("asks before enabling Cloud Monitoring and then enables it", async () => {
    render();
    await signIn();
    emit({ attemptId: "att-1", status: "monitoring_disabled", projects: PROJECTS, selectedProjectId: "p-1" });
    expect(document.querySelector("h2")?.textContent).toBe("Enable Cloud Monitoring");
    api.startGoogleAiStudioUsageLogin.mockResolvedValue({ attemptId: "att-3", authorizationUrl: "", expiresAt: "" });
    click(button("Enable Cloud Monitoring"));
    await settle();
    expect(api.startGoogleAiStudioUsageLogin).toHaveBeenLastCalledWith("acc-1", "p-1", true);
  });

  it("says so when Google signs in but returns no projects", async () => {
    render();
    await signIn();
    emit({ attemptId: "att-1", status: "choose_project", projects: [] });
    expect(errorText()).toContain("project information could not be read");
    expect(document.querySelector("h2")?.textContent).toBe("Connect Google Usage");
  });

  it("resumes a project choice that was already waiting when the dialog opened", () => {
    login.last = { attemptId: "att-9", status: "choose_project", message: null, account: null, projects: PROJECTS, selectedProjectId: "p-2" };
    render();
    expect(document.querySelector("h2")?.textContent).toBe("Choose the API key project");
  });

  it("shows a start failure in plain words and lets the user try again", async () => {
    render();
    api.startGoogleAiStudioUsageLogin.mockRejectedValue(new Error("error sending request"));
    click(button("Sign In with Google"));
    await settle();
    expect(errorText()).toBe("Couldn't start the Google Cloud connection. Check your internet connection and try again.");
    expect(button("Sign In with Google").disabled).toBe(false);
  });

  it("closing abandons the attempt at the backend", async () => {
    render();
    await signIn();
    click(button("Cancel"));
    expect(login.abandonLoginAttempt).toHaveBeenCalledWith("att-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels an attempt that finished starting after the dialog was closed", async () => {
    render();
    let resolveStart!: (value: unknown) => void;
    api.startGoogleAiStudioUsageLogin.mockReturnValue(new Promise((resolve) => (resolveStart = resolve)));
    click(button("Sign In with Google"));
    await settle();
    click(button("Cancel"));
    resolveStart({ attemptId: "late", authorizationUrl: "https://accounts.google.com/x", expiresAt: "" });
    await settle();
    expect(api.cancelLogin).toHaveBeenCalledWith("late");
    expect(login.watchLoginAttempt).not.toHaveBeenCalled();
    expect(openSafeUrl).not.toHaveBeenCalled();
  });
});
