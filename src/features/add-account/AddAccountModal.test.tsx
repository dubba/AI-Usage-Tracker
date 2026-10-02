// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginStatus, Provider } from "../../types";

const api = vi.hoisted(() => ({
  startLogin: vi.fn(),
  cancelLogin: vi.fn(async () => {}),
  addOpenCodeGoAccount: vi.fn(),
  addGrokAccount: vi.fn(),
  testGoogleAiStudioKey: vi.fn(),
  addGoogleAiStudioAccount: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

const login = vi.hoisted(() => ({
  listeners: new Set<(status: LoginStatus) => void>(),
  watchLoginAttempt: vi.fn(),
  retryLoginAttempt: vi.fn(() => false),
  abandonLoginAttempt: vi.fn(),
  recoverFromStaleLogin: vi.fn(async () => {}),
}));
vi.mock("../../shared/lib/login-status", () => ({
  subscribeLoginStatus: (listener: (status: LoginStatus) => void) => {
    login.listeners.add(listener);
    return () => login.listeners.delete(listener);
  },
  watchLoginAttempt: login.watchLoginAttempt,
  retryLoginAttempt: login.retryLoginAttempt,
  abandonLoginAttempt: login.abandonLoginAttempt,
  recoverFromStaleLogin: login.recoverFromStaleLogin,
}));

const openSafeUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../shared/lib/safeUrl", () => ({ openSafeUrl }));

import { click, mount, settle, typeInto, type Mounted } from "../../test-utils/react";
import { AddAccountModal } from "./AddAccountModal";

const ACCOUNT = { id: "acc-1", label: "Work", provider: "openai" } as never;

let mounted: Mounted;
const onAdded = vi.fn();
const onClose = vi.fn();

function render(props: { initialProvider?: Provider; initialLabel?: string } = {}) {
  mounted = mount(<AddAccountModal open onClose={onClose} onAdded={onAdded} {...props} />);
  return mounted.container;
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const primary = () => $<HTMLButtonElement>(".modal-actions .button.primary");
const heading = () => $("#add-account-title").textContent;

function emit(status: Partial<LoginStatus> & { attemptId: string; status: LoginStatus["status"] }) {
  const full = { message: null, account: null, projects: null, selectedProjectId: null, ...status } as LoginStatus;
  for (const listener of [...login.listeners]) listener(full);
}

function chooseProvider(label: string) {
  click($("#account-provider"));
  const option = Array.from(document.querySelectorAll<HTMLElement>(".custom-dropdown-item")).find((item) =>
    item.textContent?.includes(label),
  );
  if (!option) throw new Error(`no provider option "${label}"`);
  click(option);
}

beforeEach(() => {
  vi.clearAllMocks();
  login.listeners.clear();
  login.retryLoginAttempt.mockReturnValue(false);
  api.startLogin.mockResolvedValue({ attemptId: "att-1", authorizationUrl: "https://auth.example/start" });
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh)", configurable: true });
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = "";
});

describe("browser sign-in providers", () => {
  it("starts an OpenAI sign-in, opens the browser, and waits for the callback", async () => {
    render();
    expect(heading()).toBe("Which account do you want to add?");
    expect(primary().textContent).toBe("Open ChatGPT Login");
    click(primary());
    await settle();

    expect(api.startLogin).toHaveBeenCalledWith("ChatGPT", "openai", undefined);
    expect(login.watchLoginAttempt).toHaveBeenCalledWith("att-1");
    expect(openSafeUrl).toHaveBeenCalledWith("https://auth.example/start");
    expect(document.body.textContent).toContain("Waiting for the browser callback…");
    expect(primary().textContent).toBe("Connecting…");
    expect(primary().disabled).toBe(true);
  });

  it("uses the generated button label for Claude and Antigravity", () => {
    render();
    chooseProvider("Anthropic Claude");
    expect(primary().textContent).toBe("Open Claude Login");
    expect((document.getElementById("account-label") as HTMLInputElement).value).toBe("Claude");
    chooseProvider("Google Antigravity");
    expect(primary().textContent).toBe("Open Antigravity Login");
    expect((document.getElementById("account-label") as HTMLInputElement).value).toBe("Antigravity");
  });

  it("keeps a name the user typed when switching provider", () => {
    render();
    typeInto(document.getElementById("account-label") as HTMLInputElement, "My work account");
    chooseProvider("Anthropic Claude");
    expect((document.getElementById("account-label") as HTMLInputElement).value).toBe("My work account");
  });

  it("recovers from a stale sign-in that is still in progress and tries again", async () => {
    api.startLogin
      .mockRejectedValueOnce(new Error("A login is already in progress"))
      .mockResolvedValueOnce({ attemptId: "att-2", authorizationUrl: "https://auth.example/2" });
    render();
    click(primary());
    await settle();
    expect(login.recoverFromStaleLogin).toHaveBeenCalledTimes(1);
    expect(api.startLogin).toHaveBeenCalledTimes(2);
    expect(login.watchLoginAttempt).toHaveBeenCalledWith("att-2");
  });

  it("shows the error and re-enables the button when starting fails", async () => {
    api.startLogin.mockRejectedValue(new Error("network down"));
    render();
    click(primary());
    await settle();
    expect($(".modal-error").textContent).toContain("network down");
    expect(primary().disabled).toBe(false);
  });

  it("adds the account when the sign-in completes", async () => {
    render();
    click(primary());
    await settle();
    emit({ attemptId: "att-1", status: "complete", account: ACCOUNT });
    expect(onAdded).toHaveBeenCalledWith(ACCOUNT);
  });

  it("offers Retry after a failed sign-in and shows the provider's message", async () => {
    render();
    click(primary());
    await settle();
    emit({ attemptId: "att-1", status: "failed", message: "Denied by provider" });
    await settle();
    expect($(".modal-error").textContent).toBe("Denied by provider");
    expect(primary().textContent).toBe("Retry");
  });

  it("falls back to a generic failure message", async () => {
    render();
    click(primary());
    await settle();
    emit({ attemptId: "att-1", status: "failed" });
    await settle();
    expect($(".modal-error").textContent).toBe("OpenAI ChatGPT authentication failed.");
  });

  it("ignores status updates for a different attempt", async () => {
    render();
    click(primary());
    await settle();
    emit({ attemptId: "someone-else", status: "complete", account: ACCOUNT });
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("abandons the attempt and closes when cancelled", async () => {
    render();
    click(primary());
    await settle();
    click($(".modal-actions .button.ghost"));
    expect(login.abandonLoginAttempt).toHaveBeenCalledWith("att-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("cancels an attempt that finished starting after the dialog was closed", async () => {
    let resolveStart: (value: unknown) => void = () => {};
    api.startLogin.mockReturnValue(new Promise((resolve) => (resolveStart = resolve)));
    render();
    click(primary());
    click($(".modal-actions .button.ghost"));
    resolveStart({ attemptId: "late", authorizationUrl: "https://auth.example/late" });
    await settle();
    expect(api.cancelLogin).toHaveBeenCalledWith("late");
    expect(openSafeUrl).not.toHaveBeenCalled();
  });

  it("reconnects an existing account with its provider locked", async () => {
    render({ initialProvider: "anthropic", initialLabel: "Claude 2" });
    expect(heading()).toBe("Reconnect Anthropic Claude");
    expect((document.getElementById("account-provider") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("account-label") as HTMLInputElement).value).toBe("Claude 2");
    click(primary());
    await settle();
    expect(api.startLogin).toHaveBeenCalledWith("Claude 2", "anthropic", undefined);
  });

  it("describes the sign-in differently on Android", () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true });
    render({ initialProvider: "openai", initialLabel: "ChatGPT" });
    expect(document.body.textContent).toContain("Your browser opens the OpenAI ChatGPT sign-in page.");
  });
});

describe("Grok", () => {
  it("signs in through the private window without opening the browser", async () => {
    render();
    chooseProvider("xAI Grok");
    expect(primary().textContent).toBe("Open Grok Login");
    click(primary());
    await settle();
    expect(api.startLogin).toHaveBeenCalledWith("Grok", "grok", undefined);
    expect(openSafeUrl).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sign in to Grok in the private window.");
    expect(primary().textContent).toBe("Waiting for Grok…");
  });

  it("connects manually with a cookie, and requires one", async () => {
    api.addGrokAccount.mockResolvedValue(ACCOUNT);
    render();
    chooseProvider("xAI Grok");
    click($(".advanced-connection-toggle"));
    expect(primary().textContent).toBe("Connect Manually");
    expect(primary().disabled).toBe(true);
    typeInto($("#grok-cookie"), "  sso=abc  ");
    expect(primary().disabled).toBe(false);
    click(primary());
    await settle();
    expect(api.addGrokAccount).toHaveBeenCalledWith("Grok", "sso=abc");
    expect(onAdded).toHaveBeenCalledWith(ACCOUNT);
    expect(api.startLogin).not.toHaveBeenCalled();
  });

  it("can switch back to automatic sign-in", () => {
    render();
    chooseProvider("xAI Grok");
    click($(".advanced-connection-toggle"));
    expect(document.getElementById("grok-cookie")).not.toBeNull();
    click($(".advanced-connection-toggle"));
    expect(document.getElementById("grok-cookie")).toBeNull();
    expect(primary().textContent).toBe("Open Grok Login");
  });
});

describe("OpenCode Go", () => {
  it("needs an email before it can start, and rejects a malformed one", async () => {
    render();
    chooseProvider("OpenCode");
    expect(primary().disabled).toBe(true);
    typeInto($("#opencode-email"), "not-an-email");
    expect(primary().disabled).toBe(false);
    click(primary());
    await settle();
    expect($(".modal-error").textContent).toBe("A valid email address is required for OpenCode Go accounts.");
    expect(api.startLogin).not.toHaveBeenCalled();
  });

  it("signs in with the email and shows its own waiting message", async () => {
    render();
    chooseProvider("OpenCode");
    typeInto($("#opencode-email"), " me@example.com ");
    click(primary());
    await settle();
    expect(api.startLogin).toHaveBeenCalledWith("OpenCode Go", "opencode_go", "me@example.com");
    expect(openSafeUrl).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sign in to OpenCode and select Go from the sidebar.");
    expect(primary().textContent).toBe("Waiting for OpenCode…");
  });

  it("connects manually with a workspace and cookie", async () => {
    api.addOpenCodeGoAccount.mockResolvedValue(ACCOUNT);
    render();
    chooseProvider("OpenCode");
    typeInto($("#opencode-email"), "me@example.com");
    click($(".advanced-connection-toggle"));
    expect(primary().textContent).toBe("Connect Manually");
    typeInto($("#workspace-id"), " ws-1 ");
    typeInto($("#auth-cookie"), " cookie ");
    click(primary());
    await settle();
    expect(api.addOpenCodeGoAccount).toHaveBeenCalledWith("OpenCode Go", "ws-1", "cookie", "me@example.com");
    expect(onAdded).toHaveBeenCalledWith(ACCOUNT);
  });

  it("forgets the email when the provider changes", () => {
    render();
    chooseProvider("OpenCode");
    typeInto($("#opencode-email"), "me@example.com");
    chooseProvider("OpenAI ChatGPT");
    chooseProvider("OpenCode");
    expect(($("#opencode-email") as HTMLInputElement).value).toBe("");
  });
});

describe("Google AI Studio", () => {
  const probe = {
    lastUsage: { windows: [{ id: "models/gemini-a", label: "Gemini A" }, { id: "models/gemini-b", label: "Gemini B" }] },
  };

  it("loads the models, lets the user pick some, and adds the account", async () => {
    api.testGoogleAiStudioKey.mockResolvedValue(probe);
    api.addGoogleAiStudioAccount.mockResolvedValue(ACCOUNT);
    render();
    chooseProvider("Google AI Studio");
    expect(primary().textContent).toBe("Add Selected Models");
    expect(primary().disabled).toBe(true);

    typeInto($("#google-ai-studio-key"), " key-123 ");
    click($(".google-load-models"));
    await settle();
    expect(api.testGoogleAiStudioKey).toHaveBeenCalledWith("key-123");
    expect(document.querySelectorAll(".google-model-option")).toHaveLength(2);
    expect(primary().disabled).toBe(true);

    click(document.querySelectorAll<HTMLInputElement>(".google-model-option input")[1]);
    expect(primary().disabled).toBe(false);
    click(primary());
    await settle();
    expect(api.addGoogleAiStudioAccount).toHaveBeenCalledWith("AI Studio", "key-123", ["models/gemini-b"]);
    expect(onAdded).toHaveBeenCalledWith(ACCOUNT);
  });

  it("selects and clears every model", async () => {
    api.testGoogleAiStudioKey.mockResolvedValue(probe);
    render();
    chooseProvider("Google AI Studio");
    typeInto($("#google-ai-studio-key"), "k");
    click($(".google-load-models"));
    await settle();
    const [selectAll, clear] = Array.from(document.querySelectorAll<HTMLButtonElement>(".google-model-picker-actions button"));
    click(selectAll);
    expect(document.body.textContent).toContain("2 of 2 selected");
    click(clear);
    expect(document.body.textContent).toContain("0 of 2 selected");
  });

  it("reports a key that exposes no trackable models", async () => {
    api.testGoogleAiStudioKey.mockResolvedValue({ lastUsage: { windows: [] } });
    render();
    chooseProvider("Google AI Studio");
    typeInto($("#google-ai-studio-key"), "k");
    click($(".google-load-models"));
    await settle();
    expect($(".modal-error").textContent).toBe("Google returned no models that can be tracked with this key.");
  });

  it("shows a rejected key's error and drops any earlier model list", async () => {
    api.testGoogleAiStudioKey.mockResolvedValueOnce(probe).mockRejectedValueOnce(new Error("bad key"));
    render();
    chooseProvider("Google AI Studio");
    typeInto($("#google-ai-studio-key"), "k");
    click($(".google-load-models"));
    await settle();
    expect(document.querySelectorAll(".google-model-option")).toHaveLength(2);
    click($(".google-load-models"));
    await settle();
    expect($(".modal-error").textContent).toContain("bad key");
    expect(document.querySelectorAll(".google-model-option")).toHaveLength(0);
  });

  it("clears the loaded models when the key is edited", async () => {
    api.testGoogleAiStudioKey.mockResolvedValue(probe);
    render();
    chooseProvider("Google AI Studio");
    typeInto($("#google-ai-studio-key"), "k");
    click($(".google-load-models"));
    await settle();
    typeInto($("#google-ai-studio-key"), "k2");
    expect(document.querySelectorAll(".google-model-option")).toHaveLength(0);
  });

  it("shows why adding failed and lets the user try again", async () => {
    api.testGoogleAiStudioKey.mockResolvedValue(probe);
    api.addGoogleAiStudioAccount.mockRejectedValue(new Error("duplicate key"));
    render();
    chooseProvider("Google AI Studio");
    typeInto($("#google-ai-studio-key"), "k");
    click($(".google-load-models"));
    await settle();
    click(document.querySelectorAll<HTMLInputElement>(".google-model-option input")[0]);
    click(primary());
    await settle();
    expect($(".modal-error").textContent).toContain("duplicate key");
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe("Add Selected Models");
  });
});

describe("resetting", () => {
  it("clears the form when reopened", () => {
    render();
    chooseProvider("OpenCode");
    typeInto($("#opencode-email"), "me@example.com");
    mounted.rerender(<AddAccountModal open={false} onClose={onClose} onAdded={onAdded} />);
    expect(document.querySelector(".modal-card")).toBeNull();
    mounted.rerender(<AddAccountModal open onClose={onClose} onAdded={onAdded} />);
    expect((document.getElementById("account-label") as HTMLInputElement).value).toBe("ChatGPT");
    expect(document.getElementById("opencode-email")).toBeNull();
  });
});
