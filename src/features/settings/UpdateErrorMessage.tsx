import { isAllowedExternalUrl } from "../../shared/lib/safeUrl";

const URL_IN_TEXT = /(https:\/\/[^\s]+)/g;

export function UpdateErrorMessage({
  error,
  onOpenLink,
  className = "",
}: {
  error: string;
  onOpenLink: (url: string) => void;
  className?: string;
}) {
  const parts = error.split(URL_IN_TEXT);
  return (
    <div className={`error-panel settings-update-error ${className}`.trim()} role="alert">
      {parts.map((part, index) =>
        isAllowedExternalUrl(part) ? (
          <button
            key={`${part}-${index}`}
            type="button"
            className="settings-view-changelog-link settings-update-error-link"
            onClick={() => onOpenLink(part)}
          >
            {part}
          </button>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </div>
  );
}
