// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "../../test-utils/react";
import { clearRecordedErrorDetails, recentErrorDetails, useAppErrors } from "./errors";

let api: ReturnType<typeof useAppErrors>;
function capture(value: ReturnType<typeof useAppErrors>) {
  api = value;
}

function Probe() {
  capture(useAppErrors());
  return null;
}

describe("useAppErrors", () => {
  beforeEach(() => clearRecordedErrorDetails());

  it("shows the account name in the banner but keeps it out of Copy Diagnostics (L-83)", () => {
    const view = mount(<Probe />);
    act(() => api.report("remove:a1", "Account is locked", "Couldn't remove Work Laptop", "Couldn't remove an account"));

    expect(api.errors).toEqual([{ source: "remove:a1", message: "Couldn't remove Work Laptop: Account is locked" }]);
    const [line] = recentErrorDetails();
    expect(line).toContain("[remove:a1] Couldn't remove an account: Account is locked");
    expect(line).not.toContain("Work Laptop");
    view.unmount();
  });

  it("keeps the banner context in Copy Diagnostics when no separate one is given", () => {
    const view = mount(<Probe />);
    act(() => api.report("settings", "disk full", "Couldn't save settings"));
    expect(recentErrorDetails()[0]).toContain("[settings] Couldn't save settings: disk full");
    view.unmount();
  });
});
