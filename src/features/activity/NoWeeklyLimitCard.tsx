import { useId } from "react";
import { displayAccountLabel } from "../../shared/lib/usage-logic";
import { CalendarOffIcon } from "../../shared/ui/icons";
import type { Account, OtherLimit } from "../../types";
import { describeOtherLimits } from "./activity-format";

/** Stands in for the chart of an account that has no weekly limit (AI Studio, ChatGPT Free, ...). */
export function NoWeeklyLimitCard({
  account,
  otherLimits,
  monthlyOn30d = false,
}: {
  account: Account;
  otherLimits: readonly OtherLimit[];
  /** Its monthly usage is charted on the 30 day view: say so. */
  monthlyOn30d?: boolean;
}) {
  const titleId = useId();
  return (
    <article className="activity-card is-no-weekly" aria-labelledby={titleId}>
      <span className="activity-card-icon" aria-hidden="true">
        <CalendarOffIcon />
      </span>
      <div className="activity-card-identity">
        <div className="activity-card-title-row">
          <h2 className="activity-card-title" id={titleId}>{displayAccountLabel(account)}</h2>
          <span className="activity-badge">No weekly limit</span>
        </div>
        <p className="activity-card-details">
          {describeOtherLimits(otherLimits)}
          {monthlyOn30d ? " Choose 30D to see its monthly usage." : ""}
        </p>
      </div>
    </article>
  );
}
