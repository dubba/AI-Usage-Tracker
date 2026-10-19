// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, settle, type Mounted } from "../../test-utils/react";
import { ApiIntegrationWindow } from "./ApiIntegrationWindow";

const FULL_TOKEN = "dNhQ0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFVI8k";
const MASKED_TOKEN = "dNhQ••••••••••••VI8k";

const bridgeApi = vi.hoisted(() => ({
  bridgeInfo: vi.fn(),
  revealBridgeToken: vi.fn(),
  regenerateToken: vi.fn(),
}));

vi.mock("../../shared/lib/api", () => ({ bridgeApi }));

function info() {
  return {
    endpoint: "http://127.0.0.1:47831/v1/paseo-usage",
    token: MASKED_TOKEN,
    tokenLast4: "VI8k",
    enabled: true,
    running: true,
    error: null,
  };
}

describe("ApiIntegrationWindow bearer token", () => {
  let app: Mounted | null = null;

  beforeEach(() => {
    bridgeApi.bridgeInfo.mockResolvedValue(info());
    bridgeApi.revealBridgeToken.mockResolvedValue(FULL_TOKEN);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.clearAllMocks();
  });

  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((el) => el.textContent?.trim() === label)!;
  const tokenText = () => document.querySelector(".bridge-token-value code")?.textContent;

  async function open() {
    app = mount(<ApiIntegrationWindow />);
    await settle();
  }

  it("shows the masked token until Reveal is clicked", async () => {
    await open();
    expect(tokenText()).toBe(MASKED_TOKEN);
  });

  it("shows the full token after Reveal and the masked one again after Hide", async () => {
    await open();
    click(button("Reveal"));
    await settle();
    expect(bridgeApi.revealBridgeToken).toHaveBeenCalledTimes(1);
    expect(tokenText()).toBe(FULL_TOKEN);
    // The revealed token wraps instead of being cut off with an ellipsis.
    expect(document.querySelector(".bridge-token-value")?.classList.contains("is-revealed")).toBe(true);
    expect(document.querySelector("pre")?.textContent).toContain(FULL_TOKEN);

    click(button("Hide"));
    await settle();
    expect(tokenText()).toBe(MASKED_TOKEN);
    expect(document.querySelector(".bridge-token-value")?.classList.contains("is-revealed")).toBe(false);
  });

  it("explains a failed reveal in plain words", async () => {
    await open();
    bridgeApi.revealBridgeToken.mockRejectedValue(new Error("Confirmation was declined."));
    click(button("Reveal"));
    await settle();
    expect(document.querySelector("[role=alert]")?.textContent).toBe("Couldn't reveal the token: Confirmation was declined.");
  });

  it("explains a failed token change in plain words", async () => {
    await open();
    bridgeApi.regenerateToken.mockRejectedValue(new Error("error sending request"));
    click(button("Regenerate"));
    await settle();
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      "Couldn't generate a new token. Check your internet connection and try again.",
    );
  });
});
