import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useClock } from "../../shared/hooks/useClock";
import { formatMonthDay } from "../../shared/lib/format";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { HistoryResetIcon } from "../../shared/ui/icons";
import type { LimitReset, UsageWindow } from "../../types";
import { limitResetAdvice } from "./limit-reset-advice";

/** Ends the detail the backend writes for a reset that is paused or cooling down. */
const NOT_USABLE_NOW = "Not usable right now.";

function expiryLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Expires ${formatMonthDay(date)}`;
}

function withoutPeriod(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

const CANNOT_UNDO = "This can't be undone.";

/**
 * "Clears the 5-hour and 7-day limits for **Claude2**. You have only 1 left." The can't-be-undone line
 * goes at the end of the advice when there is some, so the dialog says it once, beside the numbers.
 */
function confirmBody(detail: string, accountLabel: string | undefined, usableCount: number, withAdvice: boolean) {
  return (
    <>
      {withoutPeriod(detail)}
      {accountLabel ? <> for <strong>{accountLabel}</strong></> : null}
      {`. You have only ${usableCount} left.`}
      {withAdvice ? null : ` ${CANNOT_UNDO}`}
    </>
  );
}

function expiryTime(grant: LimitReset): number {
  const time = grant.expiresAt ? new Date(grant.expiresAt).getTime() : Number.NaN;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/** Usable resets first, then the one that expires soonest, so the row shown first is the one to spend first. */
function orderedGrants(grants: LimitReset[]): LimitReset[] {
  return [...grants].sort((left, right) => {
    const usable = Number(right.usable !== false) - Number(left.usable !== false);
    return usable || expiryTime(left) - expiryTime(right);
  });
}

/**
 * The limit resets on an account card, one compact row each, under the meters. Only the first
 * shows until the person asks for the rest. Render it only when `grants` is not empty.
 */
export function LimitResetsSection({
  grants,
  windows,
  accountLabel,
  busy,
  onUse,
}: {
  grants: LimitReset[];
  /** The account's name, for the confirm dialog ("…for Claude2"). */
  accountLabel?: string;
  /** The account's usage windows, for the advice in the confirm dialog. */
  windows: UsageWindow[];
  busy: boolean;
  onUse?: (grantId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [pending, setPending] = useState<LimitReset | null>(null);
  const listId = useId();
  const ordered = orderedGrants(grants);
  const shown = showAll ? ordered : ordered.slice(0, 1);
  const hiddenCount = ordered.length - 1;
  const allReadOnly = grants.every((grant) => grant.usable === false);
  const usableCount = grants.filter((grant) => grant.usable !== false).length;
  // Follows the usage and the clock while the dialog is open, so a refresh then updates it.
  const advice = useClock((now) => (pending ? limitResetAdvice(pending, windows, now) : null));

  return (
    <section className="limit-resets-section" aria-label="Limit resets">
      <ul id={listId} className="limit-resets">
        {shown.map((grant) => {
          const readOnly = grant.usable === false;
          const expiry = expiryLabel(grant.expiresAt);
          return (
            <li key={grant.id} className={readOnly ? "limit-reset is-readonly" : "limit-reset"}>
              <span className="limit-reset-icon">
                <HistoryResetIcon />
              </span>
              <span className="limit-reset-text">
                <span className="limit-reset-name">{grant.label}</span>
                {expiry ? <span className="limit-reset-detail">{expiry}</span> : null}
              </span>
              {readOnly ? null : (
                <button
                  type="button"
                  className="button ghost limit-reset-use"
                  aria-label={`Use ${grant.label}`}
                  disabled={busy || !onUse}
                  onClick={() => setPending(grant)}
                >
                  Use
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 || allReadOnly ? (
        <div className="limit-resets-footer">
          {hiddenCount > 0 ? (
            <button
              type="button"
              className="limit-resets-more"
              aria-expanded={showAll}
              aria-controls={listId}
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll ? "Show less" : `${hiddenCount} more ${hiddenCount === 1 ? "reset" : "resets"}`}
            </button>
          ) : null}
          {allReadOnly ? (
            <p className="limit-resets-note">
              {grants.some((grant) => grant.detail.endsWith(NOT_USABLE_NOW))
                ? `${grants.length === 1 ? "This can't" : "These can't"} be used right now. Try again in a few minutes.`
                : `Redeem ${grants.length === 1 ? "it" : "these"} in Grok, under Settings → Usage.`}
            </p>
          ) : null}
        </div>
      ) : null}
      {/* A portal: the card is a containing block for fixed descendants (container-type), which clipped the dialog. */}
      {createPortal(
        <ConfirmDialog
          open={pending != null}
          kicker={pending?.label ?? "Limit reset"}
          title={usableCount > 1 ? "Use this limit reset?" : "Use your limit reset?"}
          body={pending ? confirmBody(pending.detail, accountLabel, usableCount, advice != null) : ""}
          note={advice ? `${advice} ${CANNOT_UNDO}` : undefined}
          noteTone="caution"
          cancelLabel="Keep for later"
          confirmLabel="Use reset"
          confirmDanger
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
        />,
        document.body,
      )}
    </section>
  );
}
