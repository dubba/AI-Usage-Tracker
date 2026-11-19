/**
 * Types of the values the backend sends. They are generated from the Rust types into
 * `types.generated.ts` (see `src-tauri/src/type_contract.rs`); change the Rust type and regenerate
 * rather than editing them here.
 */
export type * from "./types.generated";

/** Which update step is running, if any. Frontend state only; the backend reports `AppUpdateProgress`. */
export type UpdateBusy = "checking" | "downloading" | "verifying" | "installing" | null;
