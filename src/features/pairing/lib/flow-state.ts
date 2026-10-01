import type { ActiveFlow, IntendedRole, ViewMode } from "./view-model";

/** Where the user is in the pairing dialog, apart from what the backend reports. */
export type FlowState = {
  viewMode: ViewMode;
  /** Which way of connecting was picked; the air-gap flow reads and ends differently from Wi-Fi. */
  activeFlow: ActiveFlow;
  /** The role chosen in step 1, applied automatically once the devices connect. */
  intendedRole: IntendedRole | null;
};

export const INITIAL_FLOW: FlowState = { viewMode: "select-role", activeFlow: null, intendedRole: null };

export type FlowAction =
  | { type: "choose-role"; role: IntendedRole }
  /** Go to a view; `flow`, when given, also sets (or with null, clears) the connection method. */
  | { type: "show"; view: ViewMode; flow?: ActiveFlow }
  | { type: "set-flow"; flow: ActiveFlow }
  | { type: "reset" };

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "choose-role":
      return { ...state, intendedRole: action.role, viewMode: "select-mode" };
    case "show":
      return { ...state, viewMode: action.view, activeFlow: action.flow === undefined ? state.activeFlow : action.flow };
    case "set-flow":
      return { ...state, activeFlow: action.flow };
    case "reset":
      return INITIAL_FLOW;
  }
}
