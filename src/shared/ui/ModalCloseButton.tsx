import { CloseIcon } from "./icons";

/** The × in a dialog's top corner. `onClose` should be the same handler as the dialog's Cancel button. */
export function ModalCloseButton({ onClose, disabled }: { onClose: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="ui-modal-close"
      data-react-close="true"
      onClick={onClose}
      disabled={disabled}
      aria-label="Close dialog"
      data-tooltip="Close"
    >
      <CloseIcon />
    </button>
  );
}
