import { isReordering } from "../reorder";
import {
  EditIcon,
  UsersIcon,
} from "../../shared/ui/icons";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import {
  grokBotAverage,
  groupAlert,
  groupAverage,
  groupSecondMeterLabel,
  isGrokOnlyGroup,
  usageTone,
  type GroupAlert,
} from "../../shared/lib/usage-logic";
import { useClock } from "../../shared/hooks/useClock";
import { useUsageDisplayMode } from "../../shared/hooks/usePreferences";
import { displayPercent } from "../../shared/lib/usage-display";
import { ACCOUNT_FORMS, formatCount } from "../../shared/lib/format";
import { reorderKeyDelta } from "../reorder/reorder-utils";
import type { AccountBucket } from "../../types";
import type { SidebarGroup } from "./sidebar-groups";

/** Id of the visually hidden hint that App renders once for every reorderable group row. */
export const GROUP_REORDER_HINT_ID = "group-reorder-hint";

/**
 * Icon chip for a custom group: up to four member provider icons in the
 * group's configured account order, placed in the corners of a 2x2 grid (1st
 * top-left, 2nd bottom-right, 3rd bottom-left, 4th top-right).
 * A group whose visible accounts all share one provider keeps the single
 * provider icon; an empty group keeps the generic people icon.
 */
export function BucketGroupIcon({ group }: { group: SidebarGroup }) {
  const providers = group.accounts.slice(0, 4).map((account) => account.provider);
  if (providers.length > 1 && new Set(providers).size > 1) {
    return (
      <span className={`provider-summary-icon provider-composite composite-${providers.length}`}>
        {providers.map((provider, index) => (
          <span key={`${provider}-${index}`} className="composite-cell">
            <ProviderIcon provider={provider} />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className={`provider-summary-icon ${group.provider ? `provider-${group.provider}` : "provider-all"}`}>
      {group.provider ? <ProviderIcon provider={group.provider} /> : <UsersIcon />}
    </span>
  );
}


/** One usage window of a row: its label and percentage above a bar that fills to match. */
function SidebarMeter({
  label,
  text,
  tone,
  width,
}: {
  label: string;
  text: string;
  tone: string | null;
  width: number;
}) {
  return (
    <span className="sidebar-meter">
      <span className="sidebar-meter-head">
        <span className="sidebar-meter-label">{label}</span>
        <span className={`sidebar-meter-value ${tone == null ? "tone-na" : `tone-${tone}`}`}>{text}</span>
      </span>
      <span className="provider-summary-track" aria-hidden="true">
        <span className={tone == null ? undefined : `tone-${tone}`} style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

/** "needs sign-in" / "2 accounts need sign-in" / "1 account out of date", for the row's accessible name. */
function alertSpoken(alert: GroupAlert): string {
  const subject = alert.count === 1 ? "" : `${formatCount(alert.count, ACCOUNT_FORMS)} `;
  if (alert.level === "sign-in") return alert.count === 1 ? "needs sign-in" : `${subject}need sign-in`;
  return alert.count === 1 ? "out of date" : `${subject}out of date`;
}

export function SidebarGroupRow({
  group,
  selected,
  onSelect,
  onMove,
  onEditBucket,
}: {
  group: SidebarGroup;
  selected: boolean;
  onSelect: () => void;
  /** Keyboard alternative to dragging; only passed for groups that can be reordered. */
  onMove?: (delta: -1 | 1) => void;
  /** Opens the edit modal for custom groups (`group.type === "bucket"`). */
  onEditBucket?: (bucket: AccountBucket) => void;
}) {
  const [displayMode] = useUsageDisplayMode();
  // Grok has no 5-hour limit, so a Grok-only row uses that slot for the Grok Bot limit.
  const grokOnly = isGrokOnlyGroup(group.accounts);
  const firstMeterLabel = grokOnly ? "7D Bot" : "5h";
  const secondMeterLabel = groupSecondMeterLabel(group.accounts);
  // Each meter shows the average of the row's accounts, leaving out windows whose reset time has passed.
  const five = useClock((now) => {
    const currentNow = Math.max(now, Date.now());
    return grokOnly
      ? grokBotAverage(group.accounts, currentNow)
      : groupAverage(group.accounts, "five_hour", currentNow);
  });
  const weekly = useClock((now) => groupAverage(group.accounts, "weekly", Math.max(now, Date.now())));
  const alert = groupAlert(group.accounts);
  const meterText = (value: number | null) =>
    value == null ? "—" : `${Math.round(displayPercent(value, displayMode))}%`;
  const barWidth = (value: number | null) =>
    value == null ? 0 : Math.min(100, Math.max(0, displayPercent(value, displayMode)));
  const hasMeterData = five != null || weekly != null;
  const reorderable = group.type !== "all";
  const canEditBucket = group.type === "bucket" && Boolean(group.bucket && onEditBucket);

  const rowClassName = `provider-summary-row ${group.type === "bucket" ? "is-bucket-row" : ""} ${group.type === "all" ? "is-all-row" : ""} ${selected ? "selected" : ""}`;
  const rowAriaLabel = [
    group.title,
    formatCount(group.accounts.length, ACCOUNT_FORMS),
    alert ? alertSpoken(alert) : null,
    `${firstMeterLabel} ${meterText(five)}`,
    `${secondMeterLabel} ${meterText(weekly)}`,
  ].filter(Boolean).join(", ");

  const handleRowClick = (e: React.MouseEvent<HTMLElement>) => {
    if (isReordering()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onSelect();
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const delta = onMove ? reorderKeyDelta(event) : null;
    if (delta == null) return;
    event.preventDefault();
    onMove?.(delta);
  };

  const rowInner = (
    <>
      {reorderable ? <span className="reorder-grip" data-tooltip="Drag to reorder" aria-hidden="true" /> : null}
      {group.type === "bucket" ? (
        <BucketGroupIcon group={group} />
      ) : (
        <span className={`provider-summary-icon ${group.provider ? `provider-${group.provider}` : "provider-all"}`}>
          {group.provider ? <ProviderIcon provider={group.provider} /> : <UsersIcon />}
        </span>
      )}
      <span className="provider-summary-content">
        <span className="provider-summary-topline">
          <strong className="sidebar-group-title">
            {alert ? <span className={`sidebar-row-alert is-${alert.level}`} aria-hidden="true" /> : null}
            <span className="sidebar-group-name">{group.title}</span>
            <span className="sidebar-group-count">{group.accounts.length}</span>
          </strong>
          {canEditBucket ? (
            <button
              type="button"
              className="sidebar-group-edit-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (isReordering()) {
                  e.preventDefault();
                  return;
                }
                onEditBucket!(group.bucket!);
              }}
              aria-label={`Edit ${group.title}`}
              data-tooltip="Edit Group"
            >
              <EditIcon />
            </button>
          ) : null}
        </span>
        {group.accounts.length === 0 ? (
          <span className="sidebar-group-empty">No accounts yet</span>
        ) : alert?.level === "sign-in" && !hasMeterData ? (
          <span className="sidebar-group-signin">Sign-in needed</span>
        ) : (
          <span className="provider-average sidebar-meters">
            <SidebarMeter label={firstMeterLabel} text={meterText(five)} tone={five == null ? null : usageTone(five)} width={barWidth(five)} />
            <SidebarMeter label={secondMeterLabel} text={meterText(weekly)} tone={weekly == null ? null : usageTone(weekly)} width={barWidth(weekly)} />
          </span>
        )}
      </span>
    </>
  );

  if (canEditBucket) {
    return (
      <div
        className={rowClassName}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
        data-provider={group.provider ?? undefined}
        data-reorder-provider={group.provider ?? undefined}
        data-group-id={group.id}
        data-reorder-enabled={reorderable ? "true" : undefined}
        draggable={false}
      >
        <button
          type="button"
          className="sidebar-group-select-hit"
          onClick={(e) => {
            e.stopPropagation();
            handleRowClick(e);
          }}
          aria-keyshortcuts={onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          aria-describedby={onMove ? GROUP_REORDER_HINT_ID : undefined}
          aria-label={rowAriaLabel}
        />
        {rowInner}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={rowClassName}
      onClick={handleRowClick}
      data-provider={group.provider ?? undefined}
      data-reorder-provider={group.provider ?? undefined}
      data-group-id={group.id}
      data-reorder-enabled={reorderable ? "true" : undefined}
      draggable={false}
      aria-keyshortcuts={onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      aria-describedby={onMove ? GROUP_REORDER_HINT_ID : undefined}
      onKeyDown={handleRowKeyDown}
      aria-label={rowAriaLabel}
    >
      {rowInner}
    </button>
  );
}
