import { CloseIcon } from "./icons";

/**
 * The × in a dialog's top corner. `onClose` should be the same handler as the dialog's Cancel button.
 * `focusFirst` makes it where focus starts when the dialog opens (`useModalA11y`'s `data-autofocus`).
 */
export function ModalCloseButton({
  onClose,
  disabled,
  focusFirst,
}: {
  onClose: () => void;
  disabled?: boolean;
  focusFirst?: boolean;
}) {
  return (
    <button
      type="button"
      className="ui-modal-close"
      data-react-close="true"
      onClick={onClose}
      disabled={disabled}
      aria-label="Close dialog"
      data-autofocus={focusFirst || undefined}
    >
      <CloseIcon />
    </button>
  );
}
