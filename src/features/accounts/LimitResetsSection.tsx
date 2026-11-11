import { useId, useState } from "react";
import { formatMonthDay } from "../../shared/lib/format";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { ChevronIcon } from "../../shared/ui/icons";
import type { LimitReset } from "../../types";

function expiryLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Expires ${formatMonthDay(date)}`;
}

function confirmBody(detail: string): string {
  const sentence = detail.trim().replace(/\.+$/, "");
  return `${sentence}. This cannot be undone.`;
}

function availableLabel(count: number): string {
  const noun = count === 1 ? "Limit Reset" : "Limit Resets";
  return `You have ${count} available ${noun}`;
}

/** The limit-reset block on an account card. Render it only when `grants` is not empty. */
export function LimitResetsSection({
  grants,
  busy,
  onUse,
}: {
  grants: LimitReset[];
  busy: boolean;
  onUse?: (grantId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<LimitReset | null>(null);
  const panelId = useId();

  return (
    <section className="limit-resets-section">
      <button
        type="button"
        className="limit-resets-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="limit-resets-kicker">{availableLabel(grants.length)}</span>
        <ChevronIcon className="limit-resets-chevron" />
      </button>
      {open ? (
        <div id={panelId}>
          <ul className="limit-resets">
            {grants.map((grant) => {
              const expires = expiryLabel(grant.expiresAt);
              const readOnly = grant.usable === false;
              return (
                <li key={grant.id} className={readOnly ? "limit-reset is-readonly" : "limit-reset"}>
                  <span className="limit-reset-name">{grant.label}</span>
                  {readOnly ? null : (
                    <button
                      type="button"
                      className="button ghost limit-reset-use"
                      disabled={busy || !onUse}
                      onClick={() => setPending(grant)}
                    >
                      Use
                    </button>
                  )}
                  {expires ? <span className="limit-reset-when">{expires}</span> : <span className="limit-reset-when" />}
                  <p className="limit-reset-detail">{grant.detail}</p>
                </li>
              );
            })}
          </ul>
          <p className="limit-resets-note">
            {grants.every((grant) => grant.usable === false)
              ? "Redeem these in Grok, under Settings → Usage."
              : "Warning: This reset action cannot be undone!"}
          </p>
        </div>
      ) : null}
      <ConfirmDialog
        open={pending != null}
        kicker="Limit reset"
        title={pending?.label ?? "Limit reset"}
        body={pending ? confirmBody(pending.detail) : ""}
        confirmLabel="Use"
        busyLabel="Using…"
        busy={busy}
        onConfirm={() => {
          if (!pending || busy) return;
          onUse?.(pending.id);
          setPending(null);
        }}
        onCancel={() => {
          if (!busy) setPending(null);
        }}
      />
    </section>
  );
}
