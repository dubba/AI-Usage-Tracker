// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import type { Account } from "../../types";
import { useInlineAccountRename } from "./useInlineAccountRename";

const account = { id: "a", label: "Work", provider: "openai" } as unknown as Account;
let latest: ReturnType<typeof useInlineAccountRename>;

function capture(value: ReturnType<typeof useInlineAccountRename>) {
  latest = value;
}

function Probe({ account, onRename }: { account: Account; onRename: (label: string) => Promise<void> }) {
  capture(useInlineAccountRename(account, onRename));
  return null;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function commit() {
  await act(async () => {
    await latest.commit();
  });
}

describe("useInlineAccountRename", () => {
  it("starts showing the saved label, not editing", () => {
    mounted = mount(<Probe account={account} onRename={vi.fn()} />);
    expect(latest.editing).toBe(false);
    expect(latest.label).toBe("Work");
  });

  it("saves the trimmed label and leaves editing", async () => {
    const onRename = vi.fn(async () => {});
    mounted = mount(<Probe account={account} onRename={onRename} />);
    act(() => latest.startEditing());
    act(() => latest.setLabel("  Personal  "));
    await commit();
    expect(onRename).toHaveBeenCalledWith("Personal");
    expect(latest.editing).toBe(false);
    expect(latest.renameError).toBeNull();
  });

  it("asks for a name when the field is empty and does not save", async () => {
    const onRename = vi.fn(async () => {});
    mounted = mount(<Probe account={account} onRename={onRename} />);
    act(() => latest.startEditing());
    act(() => latest.setLabel("   "));
    await commit();
    expect(latest.renameError).toBe("Account name is required.");
    expect(latest.editing).toBe(true);
    expect(onRename).not.toHaveBeenCalled();
    // Typing clears the message.
    act(() => latest.setLabel("W"));
    expect(latest.renameError).toBeNull();
  });

  it("leaves editing without saving when the name did not change", async () => {
    const onRename = vi.fn(async () => {});
    mounted = mount(<Probe account={account} onRename={onRename} />);
    act(() => latest.startEditing());
    act(() => latest.setLabel(" Work "));
    await commit();
    expect(onRename).not.toHaveBeenCalled();
    expect(latest.editing).toBe(false);
  });

  it("keeps editing and shows why when saving fails", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("That name is taken.");
    });
    mounted = mount(<Probe account={account} onRename={onRename} />);
    act(() => latest.startEditing());
    act(() => latest.setLabel("Taken"));
    await commit();
    expect(latest.editing).toBe(true);
    expect(latest.renameError).toBe("Couldn't rename this account: That name is taken.");
  });

  it("ignores a second save while one is running", async () => {
    let finish!: () => void;
    const onRename = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    mounted = mount(<Probe account={account} onRename={onRename} />);
    act(() => latest.startEditing());
    act(() => latest.setLabel("New"));
    let first!: Promise<void>;
    await act(async () => {
      first = latest.commit();
    });
    await commit();
    expect(onRename).toHaveBeenCalledTimes(1);
    finish();
    await act(async () => {
      await first;
    });
    expect(latest.editing).toBe(false);
  });

  it("cancel restores the saved label and clears the error", async () => {
    mounted = mount(<Probe account={account} onRename={vi.fn()} />);
    act(() => latest.startEditing());
    act(() => latest.setLabel(""));
    await commit();
    act(() => latest.cancel());
    expect(latest.label).toBe("Work");
    expect(latest.renameError).toBeNull();
    expect(latest.editing).toBe(false);
  });

  it("follows a label changed elsewhere, unless the user is typing", () => {
    mounted = mount(<Probe account={account} onRename={vi.fn()} />);
    mounted.rerender(<Probe account={{ ...account, label: "Renamed" }} onRename={vi.fn()} />);
    expect(latest.label).toBe("Renamed");
    act(() => latest.startEditing());
    act(() => latest.setLabel("Typing"));
    mounted.rerender(<Probe account={{ ...account, label: "Again" }} onRename={vi.fn()} />);
    expect(latest.label).toBe("Typing");
  });
});
