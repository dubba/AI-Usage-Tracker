import { isReordering } from "../reorder";
import {
  UsersIcon,
} from "../../shared/ui/icons";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import {
  groupAverage,
  usageTone,
} from "../../shared/lib/usage-logic";
import { ACCOUNT_FORMS, formatCount } from "../../shared/lib/format";
import { reorderKeyDelta } from "../reorder/reorder-utils";
import type { SidebarGroup } from "./sidebar-groups";

/** Id of the visually hidden hint that App renders once for every reorderable group row. */
export const GROUP_REORDER_HINT_ID = "group-reorder-hint";


export function SidebarGroupRow({
  group,
  selected,
  onSelect,
  onMove,
}: {
  group: SidebarGroup;
  selected: boolean;
  onSelect: () => void;
  /** Keyboard alternative to dragging; only passed for groups that can be reordered. */
  onMove?: (delta: -1 | 1) => void;
}) {
  const five = groupAverage(group.accounts, "five_hour");
  const weekly = groupAverage(group.accounts, "weekly");
  const displayValue = five ?? weekly;
  const toneValue = five != null && weekly != null ? Math.min(five, weekly) : displayValue;
  const width = toneValue == null ? 0 : Math.min(100, Math.max(0, toneValue));
  const tone = usageTone(toneValue);
  const toneFive = five == null ? null : usageTone(five);
  const toneWeekly = weekly == null ? null : usageTone(weekly);
  const labelFive = five == null ? "—" : `${Math.round(five)}%`;
  const labelWeekly = weekly == null ? "—" : `${Math.round(weekly)}%`;
  const reorderable = group.type !== "all";
  return (
    <button
      type="button"
      className={`provider-summary-row ${group.type === "bucket" ? "is-bucket-row" : ""} ${group.type === "all" ? "is-all-row" : ""} ${selected ? "selected" : ""}`}
      onClick={(e) => {
        if (isReordering()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onSelect();
      }}
      data-provider={group.provider ?? undefined}
      data-reorder-provider={group.provider ?? undefined}
      data-group-id={group.id}
      data-reorder-enabled={reorderable ? "true" : undefined}
      draggable={false}
      aria-keyshortcuts={onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      aria-describedby={onMove ? GROUP_REORDER_HINT_ID : undefined}
      onKeyDown={(event) => {
        const delta = onMove ? reorderKeyDelta(event) : null;
        if (delta == null) return;
        event.preventDefault();
        onMove?.(delta);
      }}
      aria-label={`${group.title}, ${formatCount(group.accounts.length, ACCOUNT_FORMS)}, 5h ${labelFive}, 7d ${labelWeekly}`}
    >
      {reorderable ? <span className="reorder-grip" data-tooltip="Drag to reorder" aria-hidden="true" /> : null}
      <span className={`provider-summary-icon ${group.provider ? `provider-${group.provider}` : "provider-all"}`}>
        {group.provider ? <ProviderIcon provider={group.provider} /> : <UsersIcon />}
      </span>
      <span className="provider-summary-content">
        <span className="provider-summary-topline">
          <strong className="sidebar-group-title">
            <span className="sidebar-group-name">{group.title}</span>
            <span className="sidebar-group-count">({group.accounts.length})</span>
            {group.type === "bucket" ? <span className="bucket-mini-badge">Group</span> : null}
          </strong>
          <span className="provider-average" data-tooltip="Average left: 5-hour | 7-day">
            <span className={five == null ? "tone-na" : `tone-${toneFive}`}>{labelFive}</span>
            <span className="tone-pipe"> | </span>
            <span className={weekly == null ? "tone-na" : `tone-${toneWeekly}`}>{labelWeekly}</span>
          </span>
        </span>
        <span className="provider-summary-track" aria-hidden="true"><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
      </span>
    </button>
  );
}
