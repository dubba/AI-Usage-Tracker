import { describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { isAllowedExternalUrl, openSafeUrl } from "./safeUrl";

describe("isAllowedExternalUrl", () => {
  it("allows sign-in pages and this repository on GitHub", () => {
    for (const url of [
      "https://auth.openai.com/oauth/authorize?client_id=x&state=y",
      "https://claude.ai/oauth/authorize",
      "https://accounts.google.com/o/oauth2/auth?x=1",
      "https://accounts.x.ai/sign-in",
      "https://grok.com/",
      "https://x.ai/",
      "https://opencode.ai/auth",
      "https://github.com/dubba/AI-Usage-Tracker/releases/latest",
      "https://GitHub.com/dubba/AI-Usage-Tracker/releases",
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(true);
    }
  });

  it("refuses other schemes, hosts, repositories, and disguised URLs", () => {
    for (const url of [
      "",
      "not a url",
      "http://claude.ai/",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "https://claude.ai.evil.example/",
      "https://evil.claude.ai/",
      "https://openai.com/",
      "https://google.com/",
      "https://github.com/someone/else",
      "https://github.com/dubba/AI-Usage-Tracker-fork/",
      "https://github.com/dubba/AI-Usage-Tracker/../../someone/else",
      "https://user@claude.ai/",
      "https://claude.ai:8443/",
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false);
    }
  });
});

describe("openSafeUrl", () => {
  it("opens allowed URLs and refuses the rest without calling the opener", async () => {
    await openSafeUrl("https://claude.ai/oauth/authorize");
    expect(openUrl).toHaveBeenCalledWith("https://claude.ai/oauth/authorize");
    openUrl.mockClear();
    await expect(openSafeUrl("https://evil.example/")).rejects.toThrow(/Refusing/);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
