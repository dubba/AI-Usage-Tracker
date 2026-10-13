// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { Account } from "../../types";
import { UnprotectedSignInsModal } from "./UnprotectedSignInsModal";

function account(id: string, label: string, provider: Account["provider"]): Account {
  return {
    id,
    label,
    provider,
    email: null,
    providerAccountId: null,
    chatgptAccountId: null,
    plan: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastUsage: null,
    lastError: null,
    authRequired: false,
  } as Account;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

describe("UnprotectedSignInsModal", () => {
  it("is not shown without affected accounts", () => {
    mounted = mount(
      <UnprotectedSignInsModal accounts={null} busy={null} retryFailed={false} onRetry={vi.fn()} onRemove={vi.fn()} onClose={vi.fn()} />,
    );
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("lists the paused accounts and offers retry, remove, and not now", () => {
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    const onClose = vi.fn();
    mounted = mount(
      <UnprotectedSignInsModal
        accounts={[account("a", "Work", "anthropic"), account("b", "Home", "openai")]}
        busy={null}
        retryFailed={false}
        onRetry={onRetry}
        onRemove={onRemove}
        onClose={onClose}
      />,
    );
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("Some sign-ins aren't encrypted");
    expect(dialog?.textContent).toContain("isn't using them");
    expect([...document.querySelectorAll("li")].map((item) => item.textContent)).toHaveLength(2);
    click(button("Retry"));
    click(button("Remove and sign in again"));
    click(button("Not now"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables the buttons while busy and says when a retry did not help", () => {
    mounted = mount(
      <UnprotectedSignInsModal
        accounts={[account("a", "Work", "anthropic")]}
        busy="retry"
        retryFailed
        onRetry={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("A sign-in isn't encrypted");
    expect(button("Retrying…").disabled).toBe(true);
    expect(button("Remove and sign in again").disabled).toBe(true);
    expect(document.querySelector("[role=status]")?.textContent).toContain("Still couldn't encrypt it.");
  });
});
