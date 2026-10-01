import { describe, expect, it } from "vitest";
import { flowReducer, INITIAL_FLOW, type FlowState } from "./flow-state";

const at = (patch: Partial<FlowState>): FlowState => ({ ...INITIAL_FLOW, ...patch });

describe("flowReducer", () => {
  it("starts on the role choice with nothing picked", () => {
    expect(INITIAL_FLOW).toEqual({ viewMode: "select-role", activeFlow: null, intendedRole: null });
  });

  it("remembers the chosen role and moves on to the connection choice", () => {
    expect(flowReducer(INITIAL_FLOW, { type: "choose-role", role: "send" })).toEqual({
      viewMode: "select-mode",
      activeFlow: null,
      intendedRole: "send",
    });
  });

  it("changes view without touching the connection method unless told to", () => {
    const state = at({ viewMode: "scanner", activeFlow: "airgap" });
    expect(flowReducer(state, { type: "show", view: "airgap-sender" }).activeFlow).toBe("airgap");
    expect(flowReducer(state, { type: "show", view: "select-mode", flow: null })).toMatchObject({
      viewMode: "select-mode",
      activeFlow: null,
    });
    expect(flowReducer(state, { type: "show", view: "host", flow: "wifi" })).toMatchObject({ viewMode: "host", activeFlow: "wifi" });
  });

  it("keeps the role when going back through the views", () => {
    const state = at({ viewMode: "select-mode", intendedRole: "receive" });
    expect(flowReducer(state, { type: "show", view: "select-role" }).intendedRole).toBe("receive");
  });

  it("sets only the connection method", () => {
    expect(flowReducer(INITIAL_FLOW, { type: "set-flow", flow: "airgap" })).toEqual({ ...INITIAL_FLOW, activeFlow: "airgap" });
  });

  it("resets everything", () => {
    expect(flowReducer(at({ viewMode: "host", activeFlow: "wifi", intendedRole: "send" }), { type: "reset" })).toBe(INITIAL_FLOW);
  });
});
