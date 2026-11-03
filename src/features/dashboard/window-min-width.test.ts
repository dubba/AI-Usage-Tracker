/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_MIN_WINDOW_HEIGHT, CONFIG_MIN_WINDOW_WIDTH, windowMinWidth } from "./window-min-width";

describe("windowMinWidth", () => {
  it("leaves room for the sidebar and the account cards", () => {
    expect(windowMinWidth(320, 703)).toBe(1023);
    expect(windowMinWidth(300.4, 700.2)).toBe(1001);
  });

  it("never goes under the configured minimum", () => {
    expect(windowMinWidth(240, 600)).toBe(CONFIG_MIN_WINDOW_WIDTH);
  });

  it("keeps the configured minimum while no card has been measured", () => {
    expect(windowMinWidth(700, null)).toBe(CONFIG_MIN_WINDOW_WIDTH);
  });

  it("matches the window's minimum size in tauri.conf.json", () => {
    const config = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "src-tauri", "tauri.conf.json"), "utf8"));
    const main = config.app.windows.find((window: { label?: string }) => (window.label ?? "main") === "main");
    expect(main.minWidth).toBe(CONFIG_MIN_WINDOW_WIDTH);
    expect(main.minHeight).toBe(CONFIG_MIN_WINDOW_HEIGHT);
  });
});
