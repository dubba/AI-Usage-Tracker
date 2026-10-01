import type { AddAccountDraft } from "../strategies";

/** What every provider's form section gets from the Add Account dialog. */
export type FieldsProps = {
  draft: AddAccountDraft;
  update: (patch: Partial<AddAccountDraft>) => void;
  setError: (message: string | null) => void;
  /** An add or sign-in is in flight. */
  busy: boolean;
  isAndroid: boolean;
};
