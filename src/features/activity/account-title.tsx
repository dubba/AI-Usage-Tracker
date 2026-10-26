import type { Account } from "../../types";

/** The signed-in address, from the account or its latest usage. */
export function accountEmail(account: Account): string | null {
  const email = account.email?.trim() || account.lastUsage?.email?.trim() || "";
  return email || null;
}

/** Provider name at the title size, with the account email beside it in the smaller type. */
export function ActivityAccountTitle({ label, email }: { label: string; email: string | null }) {
  return (
    <span className="activity-card-title-line">
      <span className="activity-card-provider">{label}</span>
      {email ? (
        <>
          <span className="activity-card-dot" aria-hidden="true"> · </span>
          <span className="activity-card-email">{email}</span>
        </>
      ) : null}
    </span>
  );
}
